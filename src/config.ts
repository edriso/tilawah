import { loadEnv } from './core';

// Load the single root .env before we read any variable.
loadEnv();

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required environment variable: ${key}`);
  return value;
}

/** Parse a comma-separated list of numeric ids into a set of bigints. */
function parseIdSet(raw: string | undefined): Set<bigint> {
  const set = new Set<bigint>();
  if (!raw) return set;
  for (const part of raw.split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    try {
      set.add(BigInt(trimmed));
    } catch {
      throw new Error(`ADMIN_TELEGRAM_IDS has a non-numeric id: "${trimmed}"`);
    }
  }
  return set;
}

function parseTimezone(raw: string | undefined): string {
  const tz = raw?.trim() || 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    throw new Error(
      `TZ_NAME is not a valid IANA timezone (got "${raw}"). Try "Africa/Cairo", "Europe/London", etc.`,
    );
  }
  return tz;
}

/** "false"/"0"/"no"/"off" disable the personal user bot; anything else (and the
 *  empty default) enables it. */
function parseBool(raw: string | undefined, defaultValue: boolean): boolean {
  if (raw === undefined || raw.trim() === '') return defaultValue;
  return !['false', '0', 'no', 'off'].includes(raw.trim().toLowerCase());
}

export const config = Object.freeze({
  // REQUIRED. Bot token from @BotFather.
  botToken: requireEnv('BOT_TOKEN').trim(),
  // Default timezone for brand-new subscribers and the channel.
  defaultTimezone: parseTimezone(process.env.TZ_NAME),
  // The channel to post the wird to, as given in .env (numeric id or
  // @username). Resolved to a numeric chat id at startup. Null = no channel.
  channelChatIdRaw: process.env.CHANNEL_CHAT_ID?.trim() || null,
  // Telegram user ids allowed to run /admin_* commands (private chat only).
  adminIds: parseIdSet(process.env.ADMIN_TELEGRAM_IDS),
  // Whether the personal user bot serves individual users. Off = channel-only.
  userWirdEnabled: parseBool(process.env.USER_WIRD_ENABLED, true),
  isDev: process.env.NODE_ENV !== 'production',
});

/** True when at least one channel chat is configured. */
export function channelEnabled(): boolean {
  return config.channelChatIdRaw !== null;
}
