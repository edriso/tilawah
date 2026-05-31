import { Bot, type Context } from 'grammy';
import { toggleDay, activeDaysList, nextPageAfter } from './core';
import {
  ensureUser,
  getChannelSubscriber,
  getJuzForPage,
  setWirdSize,
  setCurrentPage,
  setActiveDays,
  setDeliveryTime,
  setTimezone,
  pauseSubscriber,
  resumeSubscriber,
  type Subscriber,
} from './database';
import { config } from './config';
import { logger } from './lib/logger';
import { COPY, settingsSummary, formatTimeAr, daysSummaryAr } from './lib/copy';
import { previewWird } from './lib/deliver';
import { runDeliveryOnce } from './scheduler';
import { buildDaysKeyboard, DAY_TOGGLE_PREFIX, DAYS_DONE } from './lib/days-keyboard';
import { buildTimeKeyboard, TIME_PICK_PREFIX } from './lib/time-keyboard';
import { buildTimezoneKeyboard, TZ_PICK_PREFIX, COMMON_TIMEZONES } from './lib/timezone-keyboard';
import { buildWirdKeyboard, WIRD_PICK_PREFIX } from './lib/wird-keyboard';
import { parseTime, isValidTimezone, parseWirdSize, parsePageNumber } from './lib/parse';

const bot = new Bot<Context>(config.botToken);

// ─── Shared helpers ─────────────────────────────────────────────────

/**
 * Resolve the USER subscriber for whoever sent this private-chat message,
 * creating the row on first contact. Returns null (and tells the user why)
 * when the personal bot is turned off, or when the message is not a private
 * chat from a real user.
 */
async function userSubscriber(ctx: Context): Promise<Subscriber | null> {
  // Personal commands are a private-chat thing; ignore them anywhere else.
  if (!ctx.from || ctx.chat?.type !== 'private') return null;
  if (!config.userWirdEnabled) {
    await ctx.reply(COPY.userBotDisabled);
    return null;
  }
  return ensureUser(BigInt(ctx.from.id), config.defaultTimezone);
}

/** Like userSubscriber but for callback queries: stays quiet in the toast. */
async function userFromCallback(ctx: Context): Promise<Subscriber | null> {
  if (!config.userWirdEnabled || !ctx.from || ctx.chat?.type !== 'private') return null;
  return ensureUser(BigInt(ctx.from.id), config.defaultTimezone);
}

/** Admin gate: a private-chat message from one of the configured admin ids. */
function isAdmin(ctx: Context): boolean {
  if (ctx.chat?.type !== 'private' || !ctx.from) return false;
  return config.adminIds.has(BigInt(ctx.from.id));
}

/** Build the status text for a subscriber, including its current juz. */
async function statusText(sub: Subscriber, isChannel = false): Promise<string> {
  const currentJuz = (await getJuzForPage(sub.currentPage)) ?? undefined;
  return settingsSummary(
    {
      deliveryHour: sub.deliveryHour,
      deliveryMinute: sub.deliveryMinute,
      activeDays: sub.activeDays,
      timezone: sub.timezone,
      wirdSize: sub.wirdSize,
      currentPage: sub.currentPage,
      pausedAt: sub.pausedAt,
      currentJuz,
    },
    { isChannel },
  );
}

// ─── User commands ──────────────────────────────────────────────────

bot.command('start', async (ctx) => {
  const sub = await userSubscriber(ctx);
  if (!sub) return;
  await ctx.reply(COPY.welcome(await statusText(sub)));
});

bot.command('help', async (ctx) => {
  if (ctx.chat?.type !== 'private') return;
  await ctx.reply(config.userWirdEnabled ? COPY.help : COPY.userBotDisabled);
});

bot.command('status', async (ctx) => {
  const sub = await userSubscriber(ctx);
  if (!sub) return;
  await ctx.reply(await statusText(sub));
});

// /today: read the current wird now, without sending the daily push or moving
// the position forward. A pure peek. May be several messages (one per page).
bot.command('today', async (ctx) => {
  const sub = await userSubscriber(ctx);
  if (!sub) return;
  const messages = await previewWird(sub);
  if (messages.length === 0) {
    logger.warn('previewWird returned no messages', { subscriberId: sub.id });
    return void ctx.reply(COPY.notReady);
  }
  for (const message of messages) await ctx.reply(message);
  if (sub.pausedAt) await ctx.reply(COPY.pausedHint);
});

// /wird: with an argument set the size directly; with none, offer buttons.
bot.command('wird', async (ctx) => {
  const sub = await userSubscriber(ctx);
  if (!sub) return;
  const arg = commandArg(ctx, 'wird');
  if (!arg) {
    return void ctx.reply(COPY.wirdPrompt(sub.wirdSize), { reply_markup: buildWirdKeyboard() });
  }
  const size = parseWirdSize(arg);
  if (size === null) return void ctx.reply(COPY.wirdInvalid);
  await setWirdSize(sub.id, size);
  await ctx.reply(COPY.wirdUpdated(size));
});

// /time: with an argument set the time directly; with none, offer buttons.
bot.command('time', async (ctx) => {
  const sub = await userSubscriber(ctx);
  if (!sub) return;
  const arg = commandArg(ctx, 'time');
  if (!arg) return void ctx.reply(COPY.timePrompt, { reply_markup: buildTimeKeyboard() });
  const parsed = parseTime(arg);
  if (!parsed) return void ctx.reply(COPY.timeInvalid);
  await setDeliveryTime(sub.id, parsed.hour, parsed.minute);
  await ctx.reply(COPY.timeUpdated(formatTimeAr(parsed.hour, parsed.minute), sub.timezone));
});

// /timezone: with an argument set it directly; with none, offer city buttons.
bot.command('timezone', async (ctx) => {
  const sub = await userSubscriber(ctx);
  if (!sub) return;
  const arg = commandArg(ctx, 'timezone');
  if (!arg) return void ctx.reply(COPY.tzPrompt, { reply_markup: buildTimezoneKeyboard() });
  if (!isValidTimezone(arg)) return void ctx.reply(COPY.tzInvalid);
  await setTimezone(sub.id, arg);
  await ctx.reply(COPY.tzUpdated(arg));
});

// /days: open the day picker.
bot.command('days', async (ctx) => {
  const sub = await userSubscriber(ctx);
  if (!sub) return;
  await ctx.reply(COPY.daysPrompt, { reply_markup: buildDaysKeyboard(sub.activeDays) });
});

// /pause: a single toggle for taking / ending a break.
bot.command('pause', async (ctx) => {
  const sub = await userSubscriber(ctx);
  if (!sub) return;
  await togglePause(ctx, sub);
});

/** Flip a subscriber's break state and reply. */
async function togglePause(ctx: Context, sub: Subscriber): Promise<void> {
  if (sub.pausedAt) {
    await resumeSubscriber(sub.id);
    await ctx.reply(COPY.resumed);
    if (activeDaysList(sub.activeDays).length === 0) await ctx.reply(COPY.daysNone);
  } else {
    await pauseSubscriber(sub.id);
    await ctx.reply(COPY.paused);
  }
}

// ─── Wird-size picker buttons ───────────────────────────────────────

bot.callbackQuery(new RegExp(`^${WIRD_PICK_PREFIX}(\\d+)$`), async (ctx) => {
  const sub = await userFromCallback(ctx);
  if (!sub) return void ctx.answerCallbackQuery();
  const size = parseWirdSize(ctx.match![1]);
  if (size === null) return void ctx.answerCallbackQuery();
  await setWirdSize(sub.id, size);
  await ctx.editMessageReplyMarkup(); // remove the keyboard
  await ctx.reply(COPY.wirdUpdated(size));
  await ctx.answerCallbackQuery();
});

// ─── Day-picker buttons ─────────────────────────────────────────────

bot.callbackQuery(new RegExp(`^${DAY_TOGGLE_PREFIX}([1-7])$`), async (ctx) => {
  const sub = await userFromCallback(ctx);
  if (!sub) return void ctx.answerCallbackQuery();
  const iso = Number(ctx.match![1]);
  const newMask = toggleDay(sub.activeDays, iso);
  await setActiveDays(sub.id, newMask);
  await ctx.editMessageReplyMarkup({ reply_markup: buildDaysKeyboard(newMask) });
  await ctx.answerCallbackQuery();
});

bot.callbackQuery(DAYS_DONE, async (ctx) => {
  const sub = await userFromCallback(ctx);
  if (!sub) return void ctx.answerCallbackQuery();
  if (activeDaysList(sub.activeDays).length === 0) {
    await ctx.reply(COPY.daysNone);
    return void ctx.answerCallbackQuery();
  }
  await ctx.editMessageReplyMarkup(); // remove the keyboard
  await ctx.reply(COPY.daysUpdated(daysSummaryAr(sub.activeDays)));
  await ctx.answerCallbackQuery();
});

// ─── Time-picker buttons ────────────────────────────────────────────

bot.callbackQuery(new RegExp(`^${TIME_PICK_PREFIX}(\\d{2})(\\d{2})$`), async (ctx) => {
  const sub = await userFromCallback(ctx);
  if (!sub) return void ctx.answerCallbackQuery();
  const hour = Number(ctx.match![1]);
  const minute = Number(ctx.match![2]);
  // The buttons we send are always valid, but callback data is client-supplied,
  // so re-check the range before storing it.
  if (hour > 23 || minute > 59) return void ctx.answerCallbackQuery();
  await setDeliveryTime(sub.id, hour, minute);
  await ctx.editMessageReplyMarkup(); // remove the keyboard
  await ctx.reply(COPY.timeUpdated(formatTimeAr(hour, minute), sub.timezone));
  await ctx.answerCallbackQuery();
});

// ─── Timezone-picker buttons ────────────────────────────────────────

bot.callbackQuery(new RegExp(`^${TZ_PICK_PREFIX}(\\d+)$`), async (ctx) => {
  const sub = await userFromCallback(ctx);
  if (!sub) return void ctx.answerCallbackQuery();
  const tz = COMMON_TIMEZONES[Number(ctx.match![1])]?.iana;
  if (!tz) return void ctx.answerCallbackQuery();
  await setTimezone(sub.id, tz);
  await ctx.editMessageReplyMarkup(); // remove the keyboard
  await ctx.reply(COPY.tzUpdated(tz));
  await ctx.answerCallbackQuery();
});

// ─── Admin / channel commands ───────────────────────────────────────
//
// Admins control the channel, which is just a subscriber row of kind
// "channel". Every command validates the admin first and the input second,
// and never changes anything on bad input.

/** Resolve the channel subscriber for an admin command, or reply and return
 *  null (not an admin, or no channel configured). */
async function adminChannel(ctx: Context): Promise<Subscriber | null> {
  if (!isAdmin(ctx)) {
    if (ctx.chat?.type === 'private') await ctx.reply(COPY.adminOnly);
    return null;
  }
  const channel = await getChannelSubscriber();
  if (!channel) {
    await ctx.reply(COPY.noChannel);
    return null;
  }
  return channel;
}

// /admin_setpage N: set the last page read; the channel resumes at N+1.
bot.command('admin_setpage', async (ctx) => {
  const channel = await adminChannel(ctx);
  if (!channel) return;
  const arg = commandArg(ctx, 'admin_setpage');
  if (!arg) return void ctx.reply(COPY.setPageUsage);
  const lastRead = parsePageNumber(arg);
  if (lastRead === null) return void ctx.reply(COPY.setPageInvalid);
  const next = nextPageAfter(lastRead);
  await setCurrentPage(channel.id, next);
  await ctx.reply(COPY.setPageDone(lastRead, next));
});

// /admin_wird N: set how many pages the channel posts per day (1..20).
bot.command('admin_wird', async (ctx) => {
  const channel = await adminChannel(ctx);
  if (!channel) return;
  const arg = commandArg(ctx, 'admin_wird');
  if (!arg) return void ctx.reply(COPY.adminWirdUsage);
  const size = parseWirdSize(arg);
  if (size === null) return void ctx.reply(COPY.adminWirdInvalid);
  await setWirdSize(channel.id, size);
  await ctx.reply(COPY.adminWirdDone(size));
});

// /admin_time HH:MM: set the channel's daily post time.
bot.command('admin_time', async (ctx) => {
  const channel = await adminChannel(ctx);
  if (!channel) return;
  const arg = commandArg(ctx, 'admin_time');
  if (!arg) return void ctx.reply(COPY.adminTimeUsage);
  const parsed = parseTime(arg);
  if (!parsed) return void ctx.reply(COPY.timeInvalid);
  await setDeliveryTime(channel.id, parsed.hour, parsed.minute);
  await ctx.reply(COPY.timeUpdated(formatTimeAr(parsed.hour, parsed.minute), channel.timezone));
});

// /admin_tz Area/City: set the channel's timezone.
bot.command('admin_tz', async (ctx) => {
  const channel = await adminChannel(ctx);
  if (!channel) return;
  const arg = commandArg(ctx, 'admin_tz');
  if (!arg) return void ctx.reply(COPY.adminTzUsage);
  if (!isValidTimezone(arg)) return void ctx.reply(COPY.tzInvalid);
  await setTimezone(channel.id, arg);
  await ctx.reply(COPY.tzUpdated(arg));
});

// /admin_pause: pause or resume the channel (toggle).
bot.command('admin_pause', async (ctx) => {
  const channel = await adminChannel(ctx);
  if (!channel) return;
  if (channel.pausedAt) {
    await resumeSubscriber(channel.id);
    await ctx.reply(COPY.channelResumed);
  } else {
    await pauseSubscriber(channel.id);
    await ctx.reply(COPY.channelPaused);
  }
});

// /admin_status: show the channel's settings and position.
bot.command('admin_status', async (ctx) => {
  const channel = await adminChannel(ctx);
  if (!channel) return;
  await ctx.reply(await statusText(channel, true));
});

// /admin_send: fire the delivery batch by hand, the exact path the cron uses.
// Handy for a smoke test right after deploy.
bot.command('admin_send', async (ctx) => {
  if (!isAdmin(ctx)) {
    if (ctx.chat?.type === 'private') await ctx.reply(COPY.adminOnly);
    return;
  }
  const stats = await runDeliveryOnce(bot);
  if (!stats) {
    await ctx.reply('A delivery run is already in progress. Try again in a moment.');
    return;
  }
  await ctx.reply(
    `Delivery run done.\nDue: ${stats.due}\nSent: ${stats.sent}\nSkipped: ${stats.skipped}\nFailed: ${stats.failed}`,
  );
});

bot.command('admin_health', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const uptime = Math.floor(process.uptime());
  const days = Math.floor(uptime / 86400);
  const hours = Math.floor((uptime % 86400) / 3600);
  const mins = Math.floor((uptime % 3600) / 60);
  await ctx.reply(
    [
      'Health',
      '------',
      `Uptime: ${days}d ${hours}h ${mins}m`,
      `Now: ${new Date().toISOString()}`,
    ].join('\n'),
  );
});

bot.catch((err) => {
  logger.error('Bot error', { error: String(err.error), update: err.ctx.update.update_id });
});

/** Set the public command menu. Personal-wird commands are listed only when
 *  the user bot is enabled; admin commands are never listed publicly. */
async function setBotCommands() {
  if (!config.userWirdEnabled) {
    await bot.api.setMyCommands([{ command: 'help', description: 'حول هذا البوت' }]);
    return;
  }
  await bot.api.setMyCommands([
    { command: 'today', description: 'قراءة ورد اليوم' },
    { command: 'wird', description: 'حجم الورد اليومي' },
    { command: 'time', description: 'ضبط وقت الإرسال' },
    { command: 'days', description: 'اختيار أيام الإرسال' },
    { command: 'timezone', description: 'ضبط المنطقة الزمنية' },
    { command: 'pause', description: 'أخذ راحة أو العودة منها' },
    { command: 'status', description: 'عرض إعداداتك' },
    { command: 'help', description: 'المساعدة' },
  ]);
}

export { bot, setBotCommands };

// ─── Small parsing helpers ──────────────────────────────────────────

/** Get the text after a "/command" (e.g. the "5" in "/wird 5"). */
function commandArg(ctx: Context, command: string): string | null {
  const raw = ctx.message?.text ?? '';
  const stripped = raw.replace(new RegExp(`^/${command}(@\\S+)?\\s*`), '').trim();
  return stripped === '' ? null : stripped;
}
