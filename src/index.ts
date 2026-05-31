import { config, channelEnabled } from './config';
import { bot, setBotCommands } from './bot';
import { startScheduler, stopScheduler, runDeliveryOnce } from './scheduler';
import { startHealthServer } from './health';
import { prisma, assertQuranSeeded, ensureChannel } from './database';
import { logger } from './lib/logger';

// Short tail before a fatal exit so the last log line reaches stdout.
const LOG_FLUSH_MS = 200;
const SHUTDOWN_TIMEOUT_MS = 5_000;
// How long to keep retrying the database at startup before giving up. A host
// may bring the bot up a moment before the database is ready.
const DB_MAX_RETRIES = 10;

/** Wait for the database to accept a query, retrying with a short backoff. */
async function waitForDatabase(): Promise<void> {
  for (let attempt = 1; attempt <= DB_MAX_RETRIES; attempt++) {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return;
    } catch (err) {
      if (attempt === DB_MAX_RETRIES) throw err;
      const delaySeconds = Math.min(attempt * 3, 30);
      logger.warn(`Database not ready (attempt ${attempt}/${DB_MAX_RETRIES}), retrying`, {
        delaySeconds,
        error: String(err),
      });
      await new Promise((r) => setTimeout(r, delaySeconds * 1000));
    }
  }
}

/**
 * Resolve the configured channel to a numeric chat id and make sure its
 * subscriber row exists. The id in config may be numeric (e.g.
 * -1001234567890) or a public @username, which we resolve with getChat. A
 * failure here is logged but not fatal: users are still served, and an admin
 * can fix the channel config without the whole bot going down.
 */
async function ensureChannelSubscriber(): Promise<void> {
  const raw = config.channelChatIdRaw;
  if (!raw) return;
  try {
    let chatId: bigint;
    try {
      chatId = BigInt(raw); // already a numeric id
    } catch {
      const chat = await bot.api.getChat(raw); // resolve @username
      chatId = BigInt(chat.id);
    }
    await ensureChannel(chatId, config.defaultTimezone);
    logger.info('Channel ready', { chatId: String(chatId) });
  } catch (err) {
    logger.error('Could not set up the channel; continuing without it', {
      channel: raw,
      error: String(err),
    });
  }
}

async function main() {
  logger.info('Tilawah bot starting', {
    isDev: config.isDev,
    defaultTz: config.defaultTimezone,
    userWird: config.userWirdEnabled,
    channel: channelEnabled(),
  });

  // "Let it crash": log, then exit so the supervisor restarts from a clean
  // state instead of running on possibly-corrupt memory.
  process.on('uncaughtException', (err) => {
    logger.error('Uncaught exception, exiting', { error: String(err) });
    exitAfterFlush(1);
  });
  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled rejection, exiting', { reason: String(reason) });
    exitAfterFlush(1);
  });

  // Wait for the database, then refuse to start unless the Quran data is fully
  // seeded. Better to fail at boot than to send a wrong page.
  await waitForDatabase();
  await assertQuranSeeded();

  await ensureChannelSubscriber();

  startHealthServer();
  await setBotCommands();

  // grammY long-polling. start() resolves only when the bot stops, so we do
  // not await it here; we let it run and continue booting the scheduler. A
  // rejection (e.g. a bad token) is fatal, so we crash and let the supervisor
  // restart us.
  void bot
    .start({ onStart: (me) => logger.info('Bot online', { username: me.username }) })
    .catch((err) => {
      logger.error('Bot polling stopped unexpectedly, exiting', { error: String(err) });
      exitAfterFlush(1);
    });

  startScheduler(bot);

  // Catch-up: a restart should still deliver today's due wird that was missed
  // while the process was down. The in-process lock and the per-day unique
  // record together stop any double-send.
  runDeliveryOnce(bot)
    .then((stats) => logger.info('Startup catch-up done', { ...(stats ?? { skipped: true }) }))
    .catch((err) => logger.error('Startup catch-up failed', { error: String(err) }));
}

async function shutdown(signal: string) {
  logger.info(`${signal} received, shutting down`);
  stopScheduler();
  await withTimeout(
    bot.stop().catch(() => {}),
    SHUTDOWN_TIMEOUT_MS,
  );
  await withTimeout(
    prisma.$disconnect().catch(() => {}),
    SHUTDOWN_TIMEOUT_MS,
  );
  exitAfterFlush(0);
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | void> {
  return Promise.race([p, new Promise<void>((r) => setTimeout(r, ms))]);
}

function exitAfterFlush(code: number): void {
  setTimeout(() => process.exit(code), LOG_FLUSH_MS).unref();
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

main().catch((err) => {
  logger.error('Fatal startup error', { error: String(err) });
  exitAfterFlush(1);
});
