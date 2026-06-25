import { Bot, InlineKeyboard, InputFile, type Context } from 'grammy';
import { autoRetry } from '@grammyjs/auto-retry';
import {
  activeDaysList,
  isValidPage,
  nextPageAfter,
  advanceStartPage,
  nextLessonIndex,
  normalizeWirdFormat,
  isWirdFormat,
  normalizeReciter,
  isReciter,
  normalizeRiwayah,
  isRiwayah,
  DEFAULT_RIWAYAH,
  riwayahLabel,
  recitersForRiwayah,
  reciterForRiwayah,
  WIRD_FORMAT_IMAGE,
} from './core';
import {
  ensureUser,
  getChannelSubscriber,
  getJuzForPage,
  setWirdSize,
  setWirdFormat,
  setCurrentPage,
  markStarted,
  restartSubscriber,
  setTajweedEnabled,
  setWirdAudioEnabled,
  setReciter,
  setRiwayah,
  toggleActiveDay,
  setDeliveryTime,
  setTimezone,
  pauseSubscriber,
  resumeSubscriber,
  commitDelivery,
  confirmRead,
  getLatestUnconfirmedDelivery,
  TAJWEED_LESSONS,
  TAJWEED_LESSON_COUNT,
  LESSONS_PENDING_REVIEW,
  type Subscriber,
} from './database';
import { config, imageWirdAvailable } from './config';
import { logger } from './lib/logger';
import { COPY, settingsSummary, formatTimeAr, daysSummaryAr } from './lib/copy';
import {
  previewWird,
  buildTodayView,
  offeredRiwayat,
  sendWird,
  tajweedLessonView,
  sendLesson,
  sendPageAudio,
  sampleAudioPagesFor,
  wirdPageNumbersFor,
  sendConfirmPrompt,
  sendWirdNow,
  sendWirdAudioNow,
  buildLessonReview,
  renderLessonAt,
  READ_CONFIRM,
  AUDIO_NOW,
  type PromptActions,
  type TodayView,
} from './lib/deliver';
import { buildTajweedKeyboard, TAJWEED_TOGGLE } from './lib/tajweed-keyboard';
import {
  buildLessonsKeyboard,
  buildLessonViewKeyboard,
  LESSONS_OPEN,
  LESSONS_PAGE_PREFIX,
  LESSONS_PICK_PREFIX,
  LESSONS_NOOP,
} from './lib/tajweed-lessons-keyboard';
import { buildReciterKeyboard, RECITER_PICK_PREFIX, RECITER_OFF } from './lib/reciter-keyboard';
import { buildRiwayahKeyboard, RIWAYAH_PICK_PREFIX } from './lib/riwayah-keyboard';
import { buildPageTafseerKeyboard } from './lib/tafseer-keyboard';
// The "try it on today's page" preview button on a reciter confirmation. A
// distinct string (no "tilawah:reciter:" colon prefix) so it never matches the
// reciter-pick handler's `^tilawah:reciter:(.+)$`.
const RECITER_SAMPLE = 'tilawah:reciter-sample';
import { runDeliveryOnce } from './scheduler';
import { buildDaysKeyboard, DAY_TOGGLE_PREFIX, DAYS_DONE } from './lib/days-keyboard';
import { buildTimeKeyboard, TIME_PICK_PREFIX } from './lib/time-keyboard';
import { buildTimezoneKeyboard, TZ_PICK_PREFIX, COMMON_TIMEZONES } from './lib/timezone-keyboard';
import { buildWirdKeyboard, WIRD_PICK_PREFIX } from './lib/wird-keyboard';
import { buildFormatKeyboard, FORMAT_PICK_PREFIX } from './lib/format-keyboard';
import {
  parseTime,
  isValidTimezone,
  parseWirdSize,
  parsePageNumber,
  parsePagePreview,
} from './lib/parse';
import { setPending, takePending, clearPending } from './lib/pending';

const bot = new Bot<Context>(config.botToken);

// Smooth Telegram's rate limits. The daily batch broadcasts to the channel and
// every due user in one minute-tick, and a wird can be several messages (pages,
// recitation, tajweed, prompt), so a busy send minute can burst past Telegram's
// flood limit and earn a 429. auto-retry catches that at the transformer layer
// for EVERY api call (text, photo, audio, callback answers), waits the server's
// retry_after, and retries — instead of dropping the message. Bounded (3 tries,
// ≤30s) and scoped to rate limits only (other errors rethrow, so the per-send
// wrappers still classify 403/blocked and transient failures as before). grammY
// recommends auto-retry over the throttler plugin.
bot.api.config.use(
  autoRetry({
    maxRetryAttempts: 3,
    maxDelaySeconds: 30,
    rethrowInternalServerErrors: true,
    rethrowHttpErrors: true,
  }),
);

// Any explicit command or button tap means the user is no longer answering a
// previous /page or /wird prompt with a bare number, so drop any stale pending
// input first. A plain-text number is left untouched here for the message
// handler below to consume. (/page and /wird set pending in their own handlers,
// which run after this, so it still sticks for them.)
bot.use(async (ctx, next) => {
  if (ctx.from && (ctx.callbackQuery || ctx.message?.text?.startsWith('/'))) {
    clearPending(ctx.from.id);
  }
  await next();
});

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
  const riwayah = normalizeRiwayah(sub.riwayah);
  const [currentJuz, offered] = await Promise.all([
    getJuzForPage(sub.currentPage, riwayah),
    offeredRiwayat(),
  ]);
  return settingsSummary(
    {
      // Show the riwayah line only when more than one riwayah is offered.
      riwayahLabel: offered.length > 1 ? riwayahLabel(riwayah) : undefined,
      deliveryHour: sub.deliveryHour,
      deliveryMinute: sub.deliveryMinute,
      activeDays: sub.activeDays,
      timezone: sub.timezone,
      wirdSize: sub.wirdSize,
      currentPage: sub.currentPage,
      pausedAt: sub.pausedAt,
      currentJuz: currentJuz ?? undefined,
      wirdFormat: normalizeWirdFormat(sub.wirdFormat),
      tajweedEnabled: sub.tajweedEnabled,
      wirdAudioEnabled: sub.wirdAudioEnabled,
      reciter: normalizeReciter(sub.reciter),
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

/**
 * Reply a TodayView's wird and, if it carries a `record`, record it as today's
 * delivery so the scheduler does not send the same wird again. Shared by /today
 * and the reposition flow (/page).
 *
 * Read-gated: recording does NOT move the position (a user advances only on a
 * confirmed read), so the wird repeats until confirmed. The record is committed
 * only AFTER the messages are shown; the unique (subscriber, date) index makes
 * it safe even if the scheduler races at the same minute. The "read ✓ / next"
 * button rides every shown wird (unless paused) so the reader can advance. The
 * missed-days nudge is NOT sent here: it leads the SCHEDULED daily push only
 * (deliverDueSubscribers), so a manual /today or a /page reposition — where the
 * reader is already engaged — is never interrupted by it, and it can never
 * repeat within one session.
 */
export async function sendTodayView(
  ctx: Context,
  sub: Subscriber,
  view: TodayView,
  now: Date,
): Promise<void> {
  // The daily tajweed lesson goes out right before the wird, but only when this
  // view will be RECORDED as today's delivery (a daily drip tied to the recorded
  // send) — not on a re-show or a paused/off-day peek.
  let lessonSent = false;
  let lessonIndex = -1;
  if (view.record) {
    const lesson = await tajweedLessonView(sub);
    if (lesson) {
      lessonSent = (await sendLesson(bot, sub.chatId, lesson)) === 'ok';
      lessonIndex = lesson.index;
    }
  }

  const { pagesSent } = await sendWird(bot, sub.chatId, view.pages, view.basmala, {
    lead: view.lead,
    format: normalizeWirdFormat(sub.wirdFormat),
    // Pass the reader's riwayah so the page IMAGE (and its file_id cache) match
    // the mushaf they chose. The text in view.pages was already loaded in the
    // right riwayah by buildTodayView, but the image source/cache is keyed on it
    // here — without it an image reader who switched would still see Hafs.
    riwayah: normalizeRiwayah(sub.riwayah),
  });

  // Record today's delivery (no advance — the position moves on a confirmed
  // read), mirroring the scheduler. Only on a free day (view.record) with at
  // least one page actually out. 'duplicate' means the scheduler beat us to it.
  let recorded = false;
  if (view.record && pagesSent > 0) {
    const committed = await commitDelivery({
      subscriberId: sub.id,
      scheduledFor: view.record.scheduledFor,
      startPage: view.record.startPage,
      pageCount: pagesSent,
      nextLessonIndex: lessonSent ? nextLessonIndex(lessonIndex, TAJWEED_LESSON_COUNT) : undefined,
      startedAt: sub.startedAt,
      now,
    });
    recorded = committed === 'sent';
  }

  // Page recitation only for a fresh delivery (not a re-show), exactly like the
  // scheduler and the ayah bot, so each page's clip arrives once.
  if (sub.wirdAudioEnabled && recorded) {
    await sendPageAudio(
      bot,
      sub.chatId,
      view.pages.slice(0, pagesSent),
      normalizeReciter(sub.reciter),
      normalizeRiwayah(sub.riwayah),
    );
  }

  // The "read ✓ / next" button rides every shown wird so the reader can confirm
  // and advance — unless paused (a resting reader is not nudged onward). It
  // carries the shown wird's start page, so a later tap names this exact wird. On
  // a fresh delivery the recitation was just auto-sent (no extra button); on a
  // re-show it was not, so offer "listen" one tap away.
  if (!sub.pausedAt && pagesSent > 0) {
    const actions = recorded ? undefined : audioActionsFor(sub);
    await sendConfirmPrompt(bot, sub.chatId, sub.currentPage, actions);
  }
}

/**
 * Move a subscriber to `page` and show the wird there (like /today). Read-gated:
 * this is a jump, not an advance — it sets the current page and shows that wird
 * with the "read ✓" button; confirming (or /next) is what moves on. If today is
 * still free the show counts as today's delivery (so the scheduler does not also
 * send it), without advancing. Shared by `/page N` and the bare-number reply.
 */
export async function repositionToPage(ctx: Context, sub: Subscriber, page: number): Promise<void> {
  await setCurrentPage(sub.id, page);
  const now = new Date();
  const view = await buildTodayView({ ...sub, currentPage: page }, now);
  if (view.pages.length === 0) {
    logger.warn('reposition produced no wird', { subscriberId: sub.id, page });
    await ctx.reply(COPY.notReady);
    return;
  }
  const juz = (await getJuzForPage(page, normalizeRiwayah(sub.riwayah))) ?? undefined;
  await ctx.reply(COPY.pageSet(page, juz));
  await sendTodayView(ctx, { ...sub, currentPage: page }, view, now);
  if (sub.pausedAt) await ctx.reply(COPY.pausedHint);
}

// /today: read today's wird now. Pulling it before the scheduled send COUNTS
// as today's delivery (we record it and move forward), so the bot does not
// send the same wird again at the user's send time. Pulling it again the same
// day just re-shows it. On an off day or while paused it stays a pure peek.
bot.command('today', async (ctx) => {
  const sub = await userSubscriber(ctx);
  if (!sub) return;
  const now = new Date();
  const view = await buildTodayView(sub, now);
  if (view.pages.length === 0) {
    logger.warn('buildTodayView returned no messages', { subscriberId: sub.id });
    await ctx.reply(COPY.notReady);
    return;
  }
  // A re-show (today already delivered, still unread) says so before the wird.
  if (view.alreadyDelivered) await ctx.reply(COPY.todayAlready);
  await sendTodayView(ctx, sub, view, now);
  if (sub.pausedAt) await ctx.reply(COPY.pausedHint);
});

/**
 * Confirm the current wird as read and show the NEXT portion now. Advances
 * exactly one wird: by the pages last actually sent if we know them, else the
 * current size; confirmRead is the idempotent compare-and-set that also marks
 * any unread days read. Exported for testing; /next is a thin wrapper.
 */
export async function advanceAndShowNext(ctx: Context, sub: Subscriber, now: Date): Promise<void> {
  // Brand-new reader who has never received a wird: SHOW their current wird (no
  // advance, no skip) and stamp "started" so the next /next advances. Without
  // this, /next would confirm-and-advance past a wird the reader never saw.
  if (sub.startedAt === null) {
    const sent = await sendWirdNow(bot, sub, COPY.wirdLead);
    if (sent === 0) {
      // A data fault (assertQuranSeeded should prevent it): show nothing and do
      // NOT stamp started, so a retry still shows this first wird.
      await ctx.reply(COPY.notReady);
      return;
    }
    // Stamp only after the wird actually went out, so the next /next advances.
    await markStarted(sub.id, now);
    if (!sub.pausedAt)
      await sendConfirmPrompt(bot, sub.chatId, sub.currentPage, audioActionsFor(sub));
    if (sub.pausedAt) await ctx.reply(COPY.pausedHint);
    return;
  }

  const latest = await getLatestUnconfirmedDelivery(sub.id);
  const size = latest ? latest.pageCount : sub.wirdSize;
  const nextPage = advanceStartPage(sub.currentPage, size);
  const result = await confirmRead(sub.id, sub.currentPage, nextPage, now);
  // Brief ack (the revealed wird carries its own "🌿 وردك التالي" lead). On a rare
  // concurrent 'already' we skip the ack but still reveal the next portion.
  if (result === 'advanced') await ctx.reply(COPY.readAdvancedAck);
  const sent = await sendWirdNow(bot, { ...sub, currentPage: nextPage }, COPY.nextLead);
  if (sent === 0) {
    await ctx.reply(COPY.notReady);
    return;
  }
  // The revealed wird rides its own "read ✓" button, carrying its start page so
  // the chain never skips, plus the on-demand "listen" button (the reveal does
  // not auto-send audio) — unless paused (a resting reader is not nudged on).
  if (!sub.pausedAt) await sendConfirmPrompt(bot, sub.chatId, nextPage, audioActionsFor(sub));
  if (sub.pausedAt) await ctx.reply(COPY.pausedHint);
}

/** Which on-demand prompt buttons a reader should see, by their settings: a
 *  "listen" button only when the recitation is on. Used for a showing that did
 *  not auto-send the audio (a /next reveal, or a /today re-show). */
function audioActionsFor(sub: Subscriber): PromptActions {
  return { audio: sub.wirdAudioEnabled };
}

// /next: confirm the current wird as read and show the NEXT portion now — for a
// reader who finished early and wants more, or who is catching up. Each /next
// advances exactly one wird (repeat it to read several in a sitting); the daily
// "read ✓" button does the same, one tap at a time.
bot.command('next', async (ctx) => {
  const sub = await userSubscriber(ctx);
  if (!sub) return;
  await advanceAndShowNext(ctx, sub, new Date());
});

// /wird: with an argument set the size directly; with none, offer buttons.
// A size change is reflected on the very next render (the wird is always the
// live portion at the current page), so there is nothing else to do here.
bot.command('wird', async (ctx) => {
  const sub = await userSubscriber(ctx);
  if (!sub) return;
  const arg = commandArg(ctx, 'wird');
  if (!arg) {
    setPending(ctx.from!.id, 'wird');
    await ctx.reply(COPY.wirdPrompt(sub.wirdSize), { reply_markup: buildWirdKeyboard() });
    return;
  }
  const size = parseWirdSize(arg);
  if (size === null) {
    await ctx.reply(COPY.wirdInvalid);
    return;
  }
  await setWirdSize(sub.id, size);
  await ctx.reply(COPY.wirdUpdated(size));
});

// /format: choose how the wird arrives, text or a picture of the Mushaf page.
// Image is offered only when a page-image source is configured on this server.
bot.command('format', async (ctx) => {
  const sub = await userSubscriber(ctx);
  if (!sub) return;
  const current = normalizeWirdFormat(sub.wirdFormat);
  await ctx.reply(COPY.formatPrompt(current, imageWirdAvailable()), {
    reply_markup: buildFormatKeyboard(current, imageWirdAvailable()),
  });
});

// /tajweed: the daily tajweed micro-lesson, posted right before the wird (on by
// default). No arg: show today's lesson as a preview + a button to toggle it.
// "/tajweed on" / "/tajweed off": set it directly.
bot.command('tajweed', async (ctx) => {
  const sub = await userSubscriber(ctx);
  if (!sub) return;
  // The deck is not live until it has been reviewed; say so rather than expose
  // a draft or a toggle that does nothing yet.
  if (LESSONS_PENDING_REVIEW) {
    await ctx.reply(COPY.tajweedComingSoon);
    return;
  }
  const arg = commandArg(ctx, 'tajweed')?.trim().toLowerCase();
  if (arg === 'on' || arg === 'off') {
    const enabled = arg === 'on';
    await setTajweedEnabled(sub.id, enabled);
    await ctx.reply(enabled ? COPY.tajweedEnabledMsg : COPY.tajweedDisabledMsg);
    return;
  }
  if (arg) {
    await ctx.reply(COPY.tajweedUsage(sub.tajweedEnabled));
    return;
  }
  // No arg: header + (when on) a preview of today's lesson + the toggle button.
  const header = COPY.tajweedStatus(sub.tajweedEnabled);
  const lesson = sub.tajweedEnabled ? await tajweedLessonView(sub) : null;
  const body = lesson ? `${header}\n\n${lesson.text}` : header;
  await ctx.reply(body, { reply_markup: buildTajweedKeyboard(sub.tajweedEnabled) });
});

/** Confirm a just-set reciter with a "try it on today's page" preview button,
 *  mirroring the ayah bot (the preview rides the confirmation, not a permanent
 *  control). Shared by /reciter <key> and the picker pick. setReciter has
 *  already turned audio on, so the button is always meaningful here. */
async function replyReciterChosen(ctx: Context, key: string): Promise<void> {
  await ctx.reply(COPY.reciterUpdated(key), {
    reply_markup: new InlineKeyboard().text(COPY.reciterSampleBtn, RECITER_SAMPLE),
  });
}

// /reciter: choose the voice for the daily page recitation, or turn it off.
// No arg: show the picker (off + reciters). "/reciter off" or "/reciter <key>"
// set it directly. On by default.
bot.command('reciter', async (ctx) => {
  const sub = await userSubscriber(ctx);
  if (!sub) return;
  const arg = commandArg(ctx, 'reciter')?.trim().toLowerCase();
  if (arg === 'off') {
    await setWirdAudioEnabled(sub.id, false);
    await ctx.reply(COPY.reciterOff);
    return;
  }
  // Only the reader's riwayah's reciters are valid (a Hafs voice cannot recite a
  // Warsh mushaf).
  const riwayah = normalizeRiwayah(sub.riwayah);
  const choices = recitersForRiwayah(riwayah);
  if (arg && isReciter(arg) && choices.includes(arg)) {
    await setReciter(sub.id, arg);
    await replyReciterChosen(ctx, arg);
    return;
  }
  // No (or unknown/wrong-riwayah) arg: show the picker reflecting the current state.
  const current = reciterForRiwayah(sub.reciter, riwayah);
  await ctx.reply(COPY.reciterPrompt(sub.wirdAudioEnabled, current), {
    reply_markup: buildReciterKeyboard(sub.wirdAudioEnabled, current, choices),
  });
});

// /riwayah: choose the transmission (mushaf) the wird arrives in. Only riwayat
// whose text AND assets are ready are offered (offeredRiwayat); when just Hafs is
// available we say so rather than show a one-button picker. Switching changes the
// mushaf (text + image), keeps the page number, and resets the reciter to one
// that recites the new riwayah.
bot.command('riwayah', async (ctx) => {
  const sub = await userSubscriber(ctx);
  if (!sub) return;
  const current = normalizeRiwayah(sub.riwayah);
  const offered = await offeredRiwayat();
  if (offered.length <= 1) {
    await ctx.reply(COPY.riwayahOnlyHafs(riwayahLabel(current)));
    return;
  }
  await ctx.reply(COPY.riwayahPrompt(riwayahLabel(current)), {
    reply_markup: buildRiwayahKeyboard(offered, current),
  });
});

// /tafsir: a link to read today's wird pages' tafseer on quran.com (one button
// per page). On-demand and link-only: a page holds many ayat, so we store no
// tafseer text — we point the reader at the page where every ayah's tafsir is a
// tap away. The pages follow the reader's live wird (their current position for
// the current wird size), so they stay correct after a /page or /wird change.
bot.command('tafsir', async (ctx) => {
  const sub = await userSubscriber(ctx);
  if (!sub) return;
  const pages = await wirdPageNumbersFor(sub);
  if (pages.length === 0) {
    await ctx.reply(COPY.tafsirNoPages);
    return;
  }
  // quran.com paginates the standard (Hafs) mushaf. For a non-Hafs reader the
  // page links still land on the right ayat but the page edges may differ, so
  // add an honest one-line note (see tafsirRiwayahNote).
  const intro =
    normalizeRiwayah(sub.riwayah) === DEFAULT_RIWAYAH
      ? COPY.tafsirIntro
      : `${COPY.tafsirIntro}\n\n${COPY.tafsirRiwayahNote}`;
  await ctx.reply(intro, { reply_markup: buildPageTafseerKeyboard(pages) });
});

// /page: jump to a specific Mushaf page (1..604). With no argument, show the
// current page and how to change it. "/page N" sets the next wird to start at
// page N (a direct go-to, unlike the admin "last page read" which is N+1).
bot.command('page', async (ctx) => {
  const sub = await userSubscriber(ctx);
  if (!sub) return;
  const arg = commandArg(ctx, 'page');
  if (!arg) {
    setPending(ctx.from!.id, 'page');
    const currentJuz =
      (await getJuzForPage(sub.currentPage, normalizeRiwayah(sub.riwayah))) ?? undefined;
    await ctx.reply(COPY.pagePrompt(sub.currentPage, currentJuz));
    return;
  }
  const page = parsePageNumber(arg);
  if (page === null) {
    await ctx.reply(COPY.pageInvalid);
    return;
  }
  await repositionToPage(ctx, sub, page);
});

// /time: with an argument set the time directly; with none, offer buttons.
bot.command('time', async (ctx) => {
  const sub = await userSubscriber(ctx);
  if (!sub) return;
  const arg = commandArg(ctx, 'time');
  if (!arg) {
    await ctx.reply(COPY.timePrompt, { reply_markup: buildTimeKeyboard() });
    return;
  }
  const parsed = parseTime(arg);
  if (!parsed) {
    await ctx.reply(COPY.timeInvalid);
    return;
  }
  await setDeliveryTime(sub.id, parsed.hour, parsed.minute);
  await ctx.reply(COPY.timeUpdated(formatTimeAr(parsed.hour, parsed.minute), sub.timezone));
});

// /timezone: with an argument set it directly; with none, offer city buttons.
bot.command('timezone', async (ctx) => {
  const sub = await userSubscriber(ctx);
  if (!sub) return;
  const arg = commandArg(ctx, 'timezone');
  if (!arg) {
    await ctx.reply(COPY.tzPrompt, { reply_markup: buildTimezoneKeyboard() });
    return;
  }
  if (!isValidTimezone(arg)) {
    await ctx.reply(COPY.tzInvalid);
    return;
  }
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
  if (!sub) {
    await ctx.answerCallbackQuery();
    return;
  }
  const size = parseWirdSize(ctx.match![1]);
  if (size === null) {
    await ctx.answerCallbackQuery();
    return;
  }
  await setWirdSize(sub.id, size);
  await ctx.editMessageReplyMarkup().catch(() => {}); // remove the keyboard (ignore a stale double-tap 400)
  await ctx.reply(COPY.wirdUpdated(size));
  await ctx.answerCallbackQuery();
});

// ─── Read-confirmation button ("read ✓ / next") ─────────────────────
//
// The button is the same action as /next: confirm THIS wird as read, advance,
// and reveal the next wird (see advanceAndShowNext). It is idempotent:
//   - The button carries the start page of the wird it was sent for. A tap whose
//     page no longer matches the current position is a STALE button from a wird
//     already passed — a gentle no-op, so old buttons left in the chat can never
//     advance the reader a second time.
//   - It works even on a /next reveal's button, which rides a wird with NO
//     recorded delivery: the idempotency guard is the page check + confirmRead's
//     compare-and-set on currentPage, NOT the presence of an unread delivery.
// `buttonStartPage` is undefined only for legacy bare "tilawah:read" buttons sent
// before the page was added; those fall back to acting on the current wird.
/**
 * Handle a "read ✓ / next" tap: confirm this wird and reveal the next, exactly
 * as /next does. A double tap, or a stale button from a wird already passed, is a
 * harmless no-op. The tapped button is removed either way. Exported for testing.
 */
export async function handleReadConfirm(
  ctx: Context,
  sub: Subscriber,
  buttonStartPage?: number,
): Promise<void> {
  // A stale button from a wird already passed (its page is no longer current).
  // Gentle no-op: drop the button so it cannot be tapped again, and reassure.
  if (buttonStartPage !== undefined && sub.currentPage !== buttonStartPage) {
    await ctx.editMessageReplyMarkup().catch(() => {});
    await ctx.answerCallbackQuery({ text: COPY.readAlready });
    return;
  }
  // Confirm + reveal the next wird, exactly as /next does, so the button and the
  // command stay in lockstep (including a reveal's button, which has no recorded
  // delivery). Drop the tapped button first (it is single-use).
  await ctx.editMessageReplyMarkup().catch(() => {});
  await ctx.answerCallbackQuery();
  await advanceAndShowNext(ctx, sub, new Date());
}

// New "read ✓" buttons carry the shown wird's start page ("tilawah:read:<page>"):
// confirm only while that wird is still current (so a stale tap is a no-op).
bot.callbackQuery(new RegExp(`^${READ_CONFIRM}:(\\d+)$`), async (ctx) => {
  const sub = await userFromCallback(ctx);
  if (!sub) {
    await ctx.answerCallbackQuery();
    return;
  }
  await handleReadConfirm(ctx, sub, Number(ctx.match![1]));
});

// Legacy bare "tilawah:read" buttons (sent before the page was added) still
// work: they act on the current wird.
bot.callbackQuery(READ_CONFIRM, async (ctx) => {
  const sub = await userFromCallback(ctx);
  if (!sub) {
    await ctx.answerCallbackQuery();
    return;
  }
  await handleReadConfirm(ctx, sub);
});

// ─── On-demand recitation (the prompt's "🎧 الاستماع") ───────────────
// Rides the prompt on a showing that did NOT auto-send the audio (a /next reveal,
// or a /today re-show). The button carries the start page of the wird that prompt
// shows, so it plays THAT wird (even one scrolled back to after advancing). Pure:
// it sends silently and never records a delivery or advances.
bot.callbackQuery(new RegExp(`^${AUDIO_NOW}:(\\d+)$`), async (ctx) => {
  const sub = await userFromCallback(ctx);
  if (!sub) {
    await ctx.answerCallbackQuery();
    return;
  }
  if (!sub.wirdAudioEnabled) {
    await ctx.answerCallbackQuery({ text: COPY.audioOff });
    return;
  }
  // Callback data is client-supplied, so re-validate the page before it reaches
  // the page math (pagesForWird throws on an out-of-range page). A crafted or
  // replayed button is a quiet no-op, like a stale "read ✓" tap.
  const page = Number(ctx.match![1]);
  if (!isValidPage(page)) {
    await ctx.answerCallbackQuery();
    return;
  }
  await ctx.answerCallbackQuery();
  // Best-effort: sendWirdAudioNow / sendPageAudio swallow their own send errors.
  // Play the wird the prompt showed (its start page), at the reader's wird size.
  await sendWirdAudioNow(bot, { ...sub, currentPage: page });
});

// ─── Format-picker buttons ──────────────────────────────────────────

bot.callbackQuery(new RegExp(`^${FORMAT_PICK_PREFIX}(text|image)$`), async (ctx) => {
  const sub = await userFromCallback(ctx);
  if (!sub) {
    await ctx.answerCallbackQuery();
    return;
  }
  const chosen = normalizeWirdFormat(ctx.match![1]);
  // Image is only honoured when a source is configured; callback data is
  // client-supplied, so re-check rather than trust the (hidden) button.
  if (chosen === WIRD_FORMAT_IMAGE && !imageWirdAvailable()) {
    await ctx.reply(COPY.formatImageUnavailable);
    await ctx.answerCallbackQuery();
    return;
  }
  await setWirdFormat(sub.id, chosen);
  await ctx.editMessageReplyMarkup().catch(() => {}); // remove the keyboard (ignore a stale double-tap 400)
  await ctx.reply(COPY.formatUpdated(chosen));
  await ctx.answerCallbackQuery();
});

// ─── Tajweed-lesson toggle button ───────────────────────────────────

bot.callbackQuery(TAJWEED_TOGGLE, async (ctx) => {
  const sub = await userFromCallback(ctx);
  if (!sub) {
    await ctx.answerCallbackQuery();
    return;
  }
  const enabled = !sub.tajweedEnabled;
  await setTajweedEnabled(sub.id, enabled);
  // Redraw the button to its new state; ignore a stale-message edit error.
  await ctx.editMessageReplyMarkup({ reply_markup: buildTajweedKeyboard(enabled) }).catch(() => {});
  await ctx.answerCallbackQuery({
    text: enabled ? COPY.tajweedToggledOn : COPY.tajweedToggledOff,
  });
});

// ─── Tajweed lessons browser ────────────────────────────────────────
//
// A read-only library of every tajweed lesson, opened from the /tajweed
// keyboard. Tapping a lesson shows it in place; "back" returns to the same list
// page. Browsing never touches the reader's daily lesson position, and works
// whether or not the daily lesson is toggled on. All four handlers no-op while
// the deck is still pending review (the open button only appears once it is
// live, but callback data is client-supplied, so re-check).

/** Swallow Telegram's "message is not modified" 400 (a stale/double-tapped
 *  button re-rendering the same view) and rethrow anything else. */
function ignoreNotModified(err: unknown): void {
  const description = (err as { description?: string }).description ?? '';
  if (!description.includes('message is not modified')) throw err;
}

// Open the index at page 0, as a NEW message so the /tajweed view (today's
// lesson + toggle) stays put above it.
bot.callbackQuery(LESSONS_OPEN, async (ctx) => {
  const sub = await userFromCallback(ctx);
  if (!sub) {
    await ctx.answerCallbackQuery();
    return;
  }
  if (LESSONS_PENDING_REVIEW) {
    await ctx.answerCallbackQuery({ text: COPY.tajweedComingSoon });
    return;
  }
  await ctx.reply(COPY.tajweedListHeader, {
    reply_markup: buildLessonsKeyboard(TAJWEED_LESSONS, 0),
  });
  await ctx.answerCallbackQuery();
});

// Show a list page. Also the "back from a lesson" target, so it restores the
// list header text (not just the keyboard) over a lesson view.
bot.callbackQuery(new RegExp(`^${LESSONS_PAGE_PREFIX}(\\d+)$`), async (ctx) => {
  const sub = await userFromCallback(ctx);
  if (!sub) {
    await ctx.answerCallbackQuery();
    return;
  }
  if (LESSONS_PENDING_REVIEW) {
    await ctx.answerCallbackQuery();
    return;
  }
  const page = Number(ctx.match![1]);
  await ctx
    .editMessageText(COPY.tajweedListHeader, {
      reply_markup: buildLessonsKeyboard(TAJWEED_LESSONS, page),
    })
    .catch(ignoreNotModified);
  await ctx.answerCallbackQuery();
});

// Show one lesson in place, with a "back to the list" button at its page.
bot.callbackQuery(new RegExp(`^${LESSONS_PICK_PREFIX}(\\d+)$`), async (ctx) => {
  const sub = await userFromCallback(ctx);
  if (!sub) {
    await ctx.answerCallbackQuery();
    return;
  }
  if (LESSONS_PENDING_REVIEW) {
    await ctx.answerCallbackQuery();
    return;
  }
  const index = Number(ctx.match![1]);
  const text = await renderLessonAt(index);
  if (!text) {
    await ctx.answerCallbackQuery({ text: COPY.tajweedLessonUnavailable });
    return;
  }
  await ctx
    .editMessageText(text, { reply_markup: buildLessonViewKeyboard(index) })
    .catch(ignoreNotModified);
  await ctx.answerCallbackQuery();
});

// The page indicator does nothing but acknowledge the tap.
bot.callbackQuery(LESSONS_NOOP, (ctx) => ctx.answerCallbackQuery());

// ─── Reciter-picker buttons ─────────────────────────────────────────

// "Off": stop the page recitation.
bot.callbackQuery(RECITER_OFF, async (ctx) => {
  const sub = await userFromCallback(ctx);
  if (!sub) {
    await ctx.answerCallbackQuery();
    return;
  }
  await setWirdAudioEnabled(sub.id, false);
  const offRiwayah = normalizeRiwayah(sub.riwayah);
  await ctx
    .editMessageReplyMarkup({
      reply_markup: buildReciterKeyboard(
        false,
        reciterForRiwayah(sub.reciter, offRiwayah),
        recitersForRiwayah(offRiwayah),
      ),
    })
    .catch(() => {});
  await ctx.answerCallbackQuery({ text: COPY.reciterToggledOff });
});

// Pick a reciter: turn audio on and set the voice.
bot.callbackQuery(new RegExp(`^${RECITER_PICK_PREFIX}(.+)$`), async (ctx) => {
  const sub = await userFromCallback(ctx);
  if (!sub) {
    await ctx.answerCallbackQuery();
    return;
  }
  const key = ctx.match![1];
  // The picked voice must belong to the reader's riwayah (a stale keyboard from
  // before a riwayah switch could carry another riwayah's reciter).
  if (!isReciter(key) || !recitersForRiwayah(normalizeRiwayah(sub.riwayah)).includes(key)) {
    await ctx.answerCallbackQuery();
    return;
  }
  await setReciter(sub.id, key);
  await ctx.editMessageReplyMarkup().catch(() => {}); // drop the picker
  await ctx.answerCallbackQuery();
  // Confirm with the "try it on today's page" preview button, like the ayah bot.
  await replyReciterChosen(ctx, key);
});

// Pick a riwayah: switch the mushaf (text + image), keep the page number, and
// reset the reciter to one that recites the new riwayah. Validates the choice is
// currently offered (a stale keyboard cannot select a since-disabled riwayah).
// Keeping the page number is safe because EVERY offered riwayah is a 604-page
// Madani mushaf: assertQuranSeeded refuses to boot a riwayah whose max page is
// not 604, so the reader's current page always exists in the new mushaf.
bot.callbackQuery(new RegExp(`^${RIWAYAH_PICK_PREFIX}(.+)$`), async (ctx) => {
  const sub = await userFromCallback(ctx);
  if (!sub) {
    await ctx.answerCallbackQuery();
    return;
  }
  const key = ctx.match![1];
  const offered = await offeredRiwayat();
  if (!isRiwayah(key) || !offered.includes(key)) {
    await ctx.answerCallbackQuery();
    return;
  }
  const reciter = reciterForRiwayah(sub.reciter, key);
  await setRiwayah(sub.id, key, reciter);
  await ctx.editMessageReplyMarkup().catch(() => {}); // drop the picker
  await ctx.answerCallbackQuery();
  await ctx.reply(COPY.riwayahUpdated(riwayahLabel(key), reciter));
});

// "Try it on today's page": play ONE page's recitation (today's delivered page,
// else the current page) in the chosen voice, as a silent peek. Never records a
// delivery or advances the position, so it is safe to tap repeatedly.
bot.callbackQuery(RECITER_SAMPLE, async (ctx) => {
  const sub = await userFromCallback(ctx);
  if (!sub) {
    await ctx.answerCallbackQuery();
    return;
  }
  if (!sub.wirdAudioEnabled) {
    await ctx.answerCallbackQuery({ text: COPY.sampleReciterOff });
    return;
  }
  const pages = await sampleAudioPagesFor(sub);
  if (pages.length === 0) {
    await ctx.answerCallbackQuery({ text: COPY.sampleNoPage });
    return;
  }
  await ctx.answerCallbackQuery({ text: COPY.sampleSent });
  // Best-effort: sendPageAudio swallows its own send errors. Pass the reader's
  // riwayah so the sample plays the chosen mushaf's recitation, not Hafs.
  await sendPageAudio(
    bot,
    sub.chatId,
    pages,
    normalizeReciter(sub.reciter),
    normalizeRiwayah(sub.riwayah),
  );
});

// ─── Day-picker buttons ─────────────────────────────────────────────

bot.callbackQuery(new RegExp(`^${DAY_TOGGLE_PREFIX}([1-7])$`), async (ctx) => {
  const sub = await userFromCallback(ctx);
  if (!sub) {
    await ctx.answerCallbackQuery();
    return;
  }
  const iso = Number(ctx.match![1]);
  // Toggle atomically at the database and use the returned mask to redraw, so
  // two fast taps can never read the same stale mask and cancel each other.
  const newMask = await toggleActiveDay(sub.id, iso);
  await ctx.editMessageReplyMarkup({ reply_markup: buildDaysKeyboard(newMask) });
  await ctx.answerCallbackQuery();
});

bot.callbackQuery(DAYS_DONE, async (ctx) => {
  const sub = await userFromCallback(ctx);
  if (!sub) {
    await ctx.answerCallbackQuery();
    return;
  }
  if (activeDaysList(sub.activeDays).length === 0) {
    await ctx.reply(COPY.daysNone);
    await ctx.answerCallbackQuery();
    return;
  }
  await ctx.editMessageReplyMarkup().catch(() => {}); // remove the keyboard (ignore a stale double-tap 400)
  await ctx.reply(COPY.daysUpdated(daysSummaryAr(sub.activeDays)));
  await ctx.answerCallbackQuery();
});

// ─── Time-picker buttons ────────────────────────────────────────────

bot.callbackQuery(new RegExp(`^${TIME_PICK_PREFIX}(\\d{2})(\\d{2})$`), async (ctx) => {
  const sub = await userFromCallback(ctx);
  if (!sub) {
    await ctx.answerCallbackQuery();
    return;
  }
  const hour = Number(ctx.match![1]);
  const minute = Number(ctx.match![2]);
  // The buttons we send are always valid, but callback data is client-supplied,
  // so re-check the range before storing it.
  if (hour > 23 || minute > 59) {
    await ctx.answerCallbackQuery();
    return;
  }
  await setDeliveryTime(sub.id, hour, minute);
  await ctx.editMessageReplyMarkup().catch(() => {}); // remove the keyboard (ignore a stale double-tap 400)
  await ctx.reply(COPY.timeUpdated(formatTimeAr(hour, minute), sub.timezone));
  await ctx.answerCallbackQuery();
});

// ─── Timezone-picker buttons ────────────────────────────────────────

bot.callbackQuery(new RegExp(`^${TZ_PICK_PREFIX}(\\d+)$`), async (ctx) => {
  const sub = await userFromCallback(ctx);
  if (!sub) {
    await ctx.answerCallbackQuery();
    return;
  }
  const tz = COMMON_TIMEZONES[Number(ctx.match![1])]?.iana;
  if (!tz) {
    await ctx.answerCallbackQuery();
    return;
  }
  await setTimezone(sub.id, tz);
  await ctx.editMessageReplyMarkup().catch(() => {}); // remove the keyboard (ignore a stale double-tap 400)
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
  if (!arg) {
    await ctx.reply(COPY.setPageUsage);
    return;
  }
  const lastRead = parsePageNumber(arg);
  if (lastRead === null) {
    await ctx.reply(COPY.setPageInvalid);
    return;
  }
  const next = nextPageAfter(lastRead);
  await setCurrentPage(channel.id, next);
  await ctx.reply(COPY.setPageDone(lastRead, next));
});

// /admin_restart: begin a fresh khatma now — channel back to page 1 and the
// first tajweed lesson. The position wraps past 604 on its own, so this is the
// clear way to start over early (e.g. a new month) instead of /admin_setpage 604.
bot.command('admin_restart', async (ctx) => {
  const channel = await adminChannel(ctx);
  if (!channel) return;
  await restartSubscriber(channel.id);
  await ctx.reply(COPY.adminRestartDone);
});

// /admin_wird N: set how many pages the channel posts per day (1..20).
bot.command('admin_wird', async (ctx) => {
  const channel = await adminChannel(ctx);
  if (!channel) return;
  const arg = commandArg(ctx, 'admin_wird');
  if (!arg) {
    await ctx.reply(COPY.adminWirdUsage);
    return;
  }
  const size = parseWirdSize(arg);
  if (size === null) {
    await ctx.reply(COPY.adminWirdInvalid);
    return;
  }
  await setWirdSize(channel.id, size);
  await ctx.reply(COPY.adminWirdDone(size));
});

// /admin_format <text|image>: how the channel posts the wird. Like the user
// /format, but arg-based to match the other admin commands. Image needs a
// page-image source configured (MUSHAF_IMAGE_BASE_URL).
bot.command('admin_format', async (ctx) => {
  const channel = await adminChannel(ctx);
  if (!channel) return;
  const arg = commandArg(ctx, 'admin_format');
  if (!arg) {
    await ctx.reply(
      COPY.adminFormatUsage(normalizeWirdFormat(channel.wirdFormat), imageWirdAvailable()),
    );
    return;
  }
  const chosen = arg.trim().toLowerCase();
  if (!isWirdFormat(chosen)) {
    await ctx.reply(COPY.adminFormatInvalid);
    return;
  }
  if (chosen === WIRD_FORMAT_IMAGE && !imageWirdAvailable()) {
    await ctx.reply(COPY.adminFormatImageUnavailable);
    return;
  }
  await setWirdFormat(channel.id, chosen);
  await ctx.reply(COPY.adminFormatDone(chosen));
});

// /admin_tajweed <on|off>: turn the channel's daily tajweed lesson on or off.
bot.command('admin_tajweed', async (ctx) => {
  const channel = await adminChannel(ctx);
  if (!channel) return;
  const arg = commandArg(ctx, 'admin_tajweed')?.trim().toLowerCase();
  if (arg !== 'on' && arg !== 'off') {
    await ctx.reply(COPY.adminTajweedUsage(channel.tajweedEnabled));
    return;
  }
  const enabled = arg === 'on';
  await setTajweedEnabled(channel.id, enabled);
  await ctx.reply(COPY.adminTajweedDone(enabled));
});

// /admin_reciter <off|key>: the channel's page-recitation voice (or off).
bot.command('admin_reciter', async (ctx) => {
  const channel = await adminChannel(ctx);
  if (!channel) return;
  const arg = commandArg(ctx, 'admin_reciter')?.trim().toLowerCase();
  if (arg === 'off') {
    await setWirdAudioEnabled(channel.id, false);
    await ctx.reply(COPY.adminReciterDone(false, normalizeReciter(channel.reciter)));
    return;
  }
  if (arg && isReciter(arg)) {
    await setReciter(channel.id, arg);
    await ctx.reply(COPY.adminReciterDone(true, arg));
    return;
  }
  await ctx.reply(
    COPY.adminReciterUsage(channel.wirdAudioEnabled, normalizeReciter(channel.reciter)),
  );
});

// /admin_time HH:MM: set the channel's daily post time.
bot.command('admin_time', async (ctx) => {
  const channel = await adminChannel(ctx);
  if (!channel) return;
  const arg = commandArg(ctx, 'admin_time');
  if (!arg) {
    await ctx.reply(COPY.adminTimeUsage);
    return;
  }
  const parsed = parseTime(arg);
  if (!parsed) {
    await ctx.reply(COPY.timeInvalid);
    return;
  }
  await setDeliveryTime(channel.id, parsed.hour, parsed.minute);
  await ctx.reply(COPY.timeUpdated(formatTimeAr(parsed.hour, parsed.minute), channel.timezone));
});

// /admin_tz Area/City: set the channel's timezone.
bot.command('admin_tz', async (ctx) => {
  const channel = await adminChannel(ctx);
  if (!channel) return;
  const arg = commandArg(ctx, 'admin_tz');
  if (!arg) {
    await ctx.reply(COPY.adminTzUsage);
    return;
  }
  if (!isValidTimezone(arg)) {
    await ctx.reply(COPY.tzInvalid);
    return;
  }
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

// /admin_preview <page> [pages]: render exactly what the bot would send for a
// given Mushaf page (or a run of pages), into the admin's DM, without changing
// the channel position or posting anywhere. A manual end-to-end test (database
// read + format) for any page. The page count defaults to 1.
bot.command('admin_preview', async (ctx) => {
  if (!isAdmin(ctx)) {
    if (ctx.chat?.type === 'private') await ctx.reply(COPY.adminOnly);
    return;
  }
  const arg = commandArg(ctx, 'admin_preview');
  if (!arg) {
    await ctx.reply('Usage: /admin_preview <page> [pages]\nExample: /admin_preview 10 2');
    return;
  }
  const parsed = parsePagePreview(arg);
  if (!parsed) {
    await ctx.reply('Bad input. Page 1..604, pages 1..20.');
    return;
  }
  const messages = await previewWird({ currentPage: parsed.page, wirdSize: parsed.pages });
  if (messages.length === 0) {
    await ctx.reply('No content for that page. Run "pnpm db:seed".');
    return;
  }
  for (const message of messages) await ctx.reply(message);
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
  if (!isAdmin(ctx)) {
    if (ctx.chat?.type === 'private') await ctx.reply(COPY.adminOnly);
    return;
  }
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

// /admin_review: send the whole tajweed lesson deck as one organized document
// to the admin's DM (every lesson + its example's verified ayah text + audio
// filename), to read, annotate, or forward to a قارئ for review. Works whether
// or not the lessons are currently live.
bot.command('admin_review', async (ctx) => {
  if (!isAdmin(ctx)) {
    if (ctx.chat?.type === 'private') await ctx.reply(COPY.adminOnly);
    return;
  }
  const doc = await buildLessonReview();
  await ctx.replyWithDocument(
    new InputFile(Buffer.from(doc, 'utf8'), 'tajweed-lessons-review.txt'),
    { caption: COPY.adminReviewCaption(TAJWEED_LESSON_COUNT) },
  );
});

// ─── Plain-text replies ─────────────────────────────────────────────
//
// Registered AFTER every command, so commands always win. This only catches
// non-command text in a private chat: a number answering a /page or /wird
// prompt, or otherwise a gentle nudge toward /help.
bot.on('message:text', async (ctx) => {
  if (!ctx.from || ctx.chat?.type !== 'private') return;
  if (!config.userWirdEnabled) {
    await ctx.reply(COPY.userBotDisabled);
    return;
  }

  const text = ctx.message.text.trim();
  // A command that reached here is unknown (real ones are handled above).
  const kind = text.startsWith('/') ? null : takePending(ctx.from.id);
  if (!kind) {
    await ctx.reply(COPY.unknownText);
    return;
  }

  const sub = await ensureUser(BigInt(ctx.from.id), config.defaultTimezone);
  if (kind === 'wird') {
    const size = parseWirdSize(text);
    if (size === null) {
      setPending(ctx.from.id, 'wird'); // keep them in the flow to retry
      await ctx.reply(COPY.wirdInvalid);
      return;
    }
    await setWirdSize(sub.id, size);
    await ctx.reply(COPY.wirdUpdated(size));
    return;
  }

  // kind === 'page'
  const page = parsePageNumber(text);
  if (page === null) {
    setPending(ctx.from.id, 'page');
    await ctx.reply(COPY.pageInvalid);
    return;
  }
  await repositionToPage(ctx, sub, page);
});

bot.catch((err) => {
  logger.error('Bot error', { error: String(err.error), update: err.ctx.update.update_id });
});

/** Set the public command menu. Personal-wird commands are listed only when
 *  the user bot is enabled; admin commands are never listed publicly. */
async function setBotCommands() {
  if (config.userWirdEnabled) {
    // Offer /riwayah in the menu only when more than one transmission is ready
    // (otherwise it would just say "only Hafs"). The rest are always present.
    // Offer /riwayah only when more than one transmission is ready (otherwise it
    // would just say "only Hafs"). Order = the daily flow, grouped: read now ->
    // the wird's shape (size, page, format) -> how it is read (riwayah, reciter,
    // tafsir, tajweed) -> schedule -> account.
    const showRiwayah = (await offeredRiwayat()).length > 1;
    await bot.api.setMyCommands([
      // Read now
      { command: 'today', description: 'قراءة ورد اليوم' },
      { command: 'next', description: 'تأكيد القراءة والانتقال إلى الورد التالي' },
      // The wird's shape
      { command: 'wird', description: 'حجم الورد اليومي' },
      { command: 'page', description: 'الانتقال إلى صفحة معيّنة' },
      { command: 'format', description: 'طريقة الإرسال: نص أو صورة' },
      // How it is read (mushaf, recitation, understanding)
      ...(showRiwayah ? [{ command: 'riwayah', description: 'اختيار الرواية (المصحف)' }] : []),
      { command: 'reciter', description: 'تلاوة الصفحة: اختيار القارئ أو الإيقاف' },
      { command: 'tafsir', description: 'تفسير صفحات وردك (رابط)' },
      { command: 'tajweed', description: 'درس التجويد اليومي (تشغيل/إيقاف)' },
      // Schedule
      { command: 'time', description: 'ضبط وقت الإرسال' },
      { command: 'days', description: 'اختيار أيام الإرسال' },
      { command: 'timezone', description: 'ضبط المنطقة الزمنية' },
      // Account
      { command: 'pause', description: 'أخذ راحة أو العودة منها' },
      { command: 'status', description: 'عرض إعداداتك' },
      { command: 'help', description: 'المساعدة' },
    ]);
  } else {
    await bot.api.setMyCommands([{ command: 'help', description: 'حول هذا البوت' }]);
  }
  // Set the About (short description) and Description the same way as the
  // commands, so the bot is self-describing on deploy — no manual @BotFather
  // step. Run on every start regardless of the wird flag. (The name, profile
  // photo, and description picture cannot be set via the Bot API; those stay
  // in @BotFather.)
  await bot.api.setMyShortDescription(COPY.botAbout);
  await bot.api.setMyDescription(COPY.botDescription);
}

export { bot, setBotCommands };

// ─── Small parsing helpers ──────────────────────────────────────────

/** Get the text after a "/command" (e.g. the "5" in "/wird 5"). */
function commandArg(ctx: Context, command: string): string | null {
  const raw = ctx.message?.text ?? '';
  const stripped = raw.replace(new RegExp(`^/${command}(@\\S+)?\\s*`), '').trim();
  return stripped === '' ? null : stripped;
}
