import { Bot, InlineKeyboard, InputFile, type Context } from 'grammy';
import {
  activeDaysList,
  nextPageAfter,
  advanceStartPage,
  nextLessonIndex,
  normalizeWirdFormat,
  isWirdFormat,
  normalizeReciter,
  isReciter,
  WIRD_FORMAT_IMAGE,
} from './core';
import {
  ensureUser,
  getChannelSubscriber,
  getJuzForPage,
  setWirdSize,
  setWirdFormat,
  setCurrentPage,
  restartSubscriber,
  setTajweedEnabled,
  setWirdAudioEnabled,
  setReciter,
  toggleActiveDay,
  setDeliveryTime,
  setTimezone,
  pauseSubscriber,
  resumeSubscriber,
  commitDelivery,
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
  sendWird,
  tajweedLessonView,
  sendLesson,
  sendPageAudio,
  sampleAudioPagesFor,
  buildLessonReview,
  renderLessonAt,
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
 * Reply a TodayView's wird and, if it carries a claim, record it as today's
 * delivery so the scheduler does not send the same wird again. Shared by /today
 * and the reposition flow (/page). The claim is committed only AFTER the
 * messages are shown, so a failed reply leaves the day unclaimed; the unique
 * (subscriber, date) index makes it safe even if the scheduler races at the
 * same minute (see scheduler.ts).
 */
async function sendTodayView(
  ctx: Context,
  sub: Subscriber,
  view: TodayView,
  now: Date,
): Promise<void> {
  // The daily tajweed lesson goes out right before the wird, but only when this
  // view will be claimed as today's delivery (not on a re-show or a preview).
  let lessonSent = false;
  let lessonIndex = -1;
  if (view.claim) {
    const lesson = await tajweedLessonView(sub);
    if (lesson) {
      lessonSent = (await sendLesson(bot, sub.chatId, lesson)) === 'ok';
      lessonIndex = lesson.index;
    }
  }

  const { pagesSent } = await sendWird(bot, sub.chatId, view.pages, view.basmala, {
    lead: view.lead,
    format: normalizeWirdFormat(sub.wirdFormat),
  });
  // Record exactly what went out, advancing by pagesSent — mirroring the
  // scheduler (deliver.ts). On a partial send (e.g. an image source dies mid-
  // wird) this records the pages that actually arrived and rolls the rest to a
  // later run; committing the FULL wird here, or nothing at all, would make the
  // scheduler re-send pages the user already received. pagesSent === 0 sends
  // nothing, so there is nothing to claim or advance.
  const committed =
    view.claim && pagesSent > 0
      ? await commitDelivery({
          subscriberId: sub.id,
          scheduledFor: view.claim.scheduledFor,
          startPage: view.claim.startPage,
          pageCount: pagesSent,
          nextPage: advanceStartPage(view.claim.startPage, pagesSent),
          nextLessonIndex: lessonSent
            ? nextLessonIndex(lessonIndex, TAJWEED_LESSON_COUNT)
            : undefined,
          startedAt: sub.startedAt,
          now,
        })
      : null;

  // After the wird, send the page recitation — but only for a real, new
  // delivery, exactly like the scheduler (deliver.ts) and the ayah bot. A
  // re-show or a preview (no claim), or the loser of a race with the scheduler
  // ('duplicate'), shows the wird again but does NOT re-send the audio, so each
  // page's recitation arrives once, with its delivery, never on every /today.
  if (sub.wirdAudioEnabled && committed === 'sent') {
    await sendPageAudio(
      bot,
      sub.chatId,
      view.pages.slice(0, pagesSent),
      normalizeReciter(sub.reciter),
    );
  }
}

/**
 * Move a subscriber to `page`, then auto-send the wird at the new page (like
 * /today): when today is still free it counts as today's delivery (so the
 * scheduler does not also send it) and the position advances past this page;
 * otherwise (already delivered today, an off day, or paused) it is shown as a
 * preview and the position stays here, to arrive at the next scheduled time.
 * Shared by `/page N` and the bare-number reply to a /page prompt.
 */
export async function repositionToPage(ctx: Context, sub: Subscriber, page: number): Promise<void> {
  await setCurrentPage(sub.id, page);
  const now = new Date();
  const view = await buildTodayView({ ...sub, currentPage: page }, now, { reposition: true });
  if (view.pages.length === 0) {
    logger.warn('reposition produced no wird', { subscriberId: sub.id, page });
    await ctx.reply(COPY.notReady);
    return;
  }
  const juz = (await getJuzForPage(page)) ?? undefined;
  await ctx.reply(
    view.claim
      ? COPY.pageSetClaimed(page, view.claim.nextPage, juz)
      : COPY.pageSetPreview(page, juz),
  );
  await sendTodayView(ctx, sub, view, now);
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
  if (view.alreadyDelivered) await ctx.reply(COPY.todayAlready);
  await sendTodayView(ctx, sub, view, now);
  if (sub.pausedAt) await ctx.reply(COPY.pausedHint);
});

// /wird: with an argument set the size directly; with none, offer buttons.
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
  if (arg && isReciter(arg)) {
    await setReciter(sub.id, arg);
    await replyReciterChosen(ctx, arg);
    return;
  }
  // No (or unknown) arg: show the picker reflecting the current state.
  const current = normalizeReciter(sub.reciter);
  await ctx.reply(COPY.reciterPrompt(sub.wirdAudioEnabled, current), {
    reply_markup: buildReciterKeyboard(sub.wirdAudioEnabled, current),
  });
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
    const currentJuz = (await getJuzForPage(sub.currentPage)) ?? undefined;
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
  await ctx.editMessageReplyMarkup(); // remove the keyboard
  await ctx.reply(COPY.wirdUpdated(size));
  await ctx.answerCallbackQuery();
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
  await ctx.editMessageReplyMarkup(); // remove the keyboard
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
  await ctx
    .editMessageReplyMarkup({
      reply_markup: buildReciterKeyboard(false, normalizeReciter(sub.reciter)),
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
  if (!isReciter(key)) {
    await ctx.answerCallbackQuery();
    return;
  }
  await setReciter(sub.id, key);
  await ctx.editMessageReplyMarkup().catch(() => {}); // drop the picker
  await ctx.answerCallbackQuery();
  // Confirm with the "try it on today's page" preview button, like the ayah bot.
  await replyReciterChosen(ctx, key);
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
  const pages = await sampleAudioPagesFor(sub, new Date());
  if (pages.length === 0) {
    await ctx.answerCallbackQuery({ text: COPY.sampleNoPage });
    return;
  }
  await ctx.answerCallbackQuery({ text: COPY.sampleSent });
  // Best-effort: sendPageAudio swallows its own send errors.
  await sendPageAudio(bot, sub.chatId, pages, normalizeReciter(sub.reciter));
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
  await ctx.editMessageReplyMarkup(); // remove the keyboard
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
  await ctx.editMessageReplyMarkup(); // remove the keyboard
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
    await bot.api.setMyCommands([
      { command: 'today', description: 'قراءة ورد اليوم' },
      { command: 'wird', description: 'حجم الورد اليومي' },
      { command: 'tajweed', description: 'درس التجويد اليومي (تشغيل/إيقاف)' },
      { command: 'reciter', description: 'تلاوة الصفحة: اختيار القارئ أو الإيقاف' },
      { command: 'format', description: 'طريقة الإرسال: نص أو صورة' },
      { command: 'page', description: 'الانتقال إلى صفحة معيّنة' },
      { command: 'time', description: 'ضبط وقت الإرسال' },
      { command: 'days', description: 'اختيار أيام الإرسال' },
      { command: 'timezone', description: 'ضبط المنطقة الزمنية' },
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
