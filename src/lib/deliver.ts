import { InlineKeyboard, InputFile, type Bot, type Context } from 'grammy';
import {
  dueLocalDate,
  advanceStartPage,
  formatWird,
  pageBanner,
  getLocalContext,
  isDayActive,
  mushafImageSource,
  tajweedAudioSource,
  isHttpSource,
  normalizeWirdFormat,
  formatLesson,
  lessonIndexInRange,
  nextLessonIndex,
  toArabicDigits,
  pageAudioSource,
  normalizeReciter,
  WIRD_FORMAT_IMAGE,
  type WirdFormat,
  type PageContent,
  type ReciterKey,
} from '../core';
import {
  listDeliverableSubscribers,
  hasDeliveryFor,
  getDeliveryFor,
  countUnreadDeliveriesBefore,
  getWird,
  getAyahText,
  getBasmala,
  commitDelivery,
  markBlocked,
  getCachedPageImageIds,
  cachePageImageId,
  getCachedTajweedAudioId,
  cacheTajweedAudioId,
  getCachedPageAudioId,
  cachePageAudioId,
  pickQuranVirtue,
  TAJWEED_LESSONS,
  TAJWEED_LESSON_COUNT,
  LESSONS_PENDING_REVIEW,
  KIND_USER,
  KIND_CHANNEL,
  type DeliverableSubscriber,
} from '../database';
import { config, channelEnabled } from '../config';
import { sendMessages, type SendResult } from './send';
import { sendPhoto, sendPhotoAlbum, MAX_ALBUM_SIZE } from './send-photo';
import { sendAudio } from './send-audio';
import { COPY, reciterNameAr } from './copy';
import { logger } from './logger';

/** Callback-data PREFIX for the "read ✓ / next" button under a user's wird. The
 *  shown wird's start page is appended ("tilawah:read:<startPage>") so a tap names
 *  the exact wird it was sent for: handleReadConfirm confirms only while that page
 *  is still the reader's current position, and a tap on an old button (from a wird
 *  already passed) is a gentle no-op. */
export const READ_CONFIRM = 'tilawah:read';

/** Build the callback data for a wird's "read ✓" button (carries the wird's
 *  start page so stale taps are detectable). See READ_CONFIRM. */
export function readConfirmData(startPage: number): string {
  return `${READ_CONFIRM}:${startPage}`;
}

export interface DeliveryStats {
  due: number;
  sent: number;
  skipped: number;
  failed: number;
}

/** Which subscriber kinds this deployment serves, from config. */
export function allowedKinds(): string[] {
  const kinds: string[] = [];
  if (config.userWirdEnabled) kinds.push(KIND_USER);
  if (channelEnabled()) kinds.push(KIND_CHANNEL);
  return kinds;
}

export interface SendWirdOptions {
  /** Lead line prepended to the FIRST page only (e.g. "🌿 وردك اليوم"). */
  lead?: string;
  /** "text" (plain Quran text) or "image" (a photo of the Mushaf page). */
  format: WirdFormat;
}

export interface SendWirdResult {
  /** How many pages actually went out (0 if the first page failed). */
  pagesSent: number;
  /** The result of the last attempted send, for blocked/failed handling. */
  lastResult: SendResult;
}

/** Split a list into consecutive chunks of at most `size`, preserving order. */
function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * How a page is sent as a photo: a cached Telegram file_id (resend), an http URL
 * (Telegram fetches it), or a local file the bot uploads (InputFile, for
 * self-hosted images on a bot with no public URL). Null when no source is
 * configured, so the caller sends the page as text instead.
 */
function resolvePhoto(
  pageNumber: number,
  cached: Map<number, string>,
  baseUrl: string | null,
): string | InputFile | null {
  const cachedId = cached.get(pageNumber);
  if (cachedId) return cachedId;
  if (!baseUrl) return null;
  const src = mushafImageSource(baseUrl, pageNumber);
  return isHttpSource(src) ? src : new InputFile(src);
}

/** A page photo's caption: the page banner, with the wird lead prepended on the
 *  very first page of the wird only. (Each Mushaf image already shows its own
 *  page number, so this is just a friendly header, not the only label.) */
function imageCaption(page: PageContent, lead?: string): string {
  const banner = pageBanner(page);
  return lead ? `${lead}\n\n${banner}` : banner;
}

/** Remember a page's file_id for next time, unless it is already what we sent.
 *  Updates the in-memory map too, so one wird never re-caches the same id. */
async function cacheFileId(
  pageNumber: number,
  fileId: string | undefined,
  cached: Map<number, string>,
): Promise<void> {
  if (!fileId || cached.get(pageNumber) === fileId) return;
  try {
    await cachePageImageId(pageNumber, fileId);
    cached.set(pageNumber, fileId);
  } catch (err) {
    logger.warn('Could not cache page image file_id', { page: pageNumber, error: String(err) });
  }
}

/**
 * Send a wird (one or more pages) to a chat, in reading order, in the
 * subscriber's chosen format. The caller advances the position by exactly
 * `pagesSent`, so a mid-wird failure never skips a page nor re-sends one that
 * already arrived.
 *
 * TEXT: one message (set) per page, in order.
 *
 * IMAGE: pages are grouped into albums of up to 10 and sent with one
 * sendMediaGroup per group, so a multi-page wird arrives as a single, ordered,
 * one-notification post that reads like a slice of the Mushaf. A 1-page group is
 * a plain photo. Each page image already shows its own number, so only the first
 * item of the first album carries the lead/banner caption. The first time a page
 * is sent, Telegram is given the source (URL or uploaded file) and we cache the
 * file_id it returns, so every later send is a cheap reference.
 *
 * Robustness: an album is atomic, so if a group fails (e.g. one missing page) we
 * fall back to sending that group page-by-page, and a failed single photo falls
 * back to TEXT for that page. So a bad source can never wedge a subscriber or
 * cost the rest of the wird: the holy text always goes out. (A real Telegram
 * outage fails the text send too, so nothing is sent and it is retried next run.)
 */
export async function sendWird(
  bot: Bot<Context>,
  chatId: bigint,
  pages: PageContent[],
  basmala: string,
  opts: SendWirdOptions,
): Promise<SendWirdResult> {
  if (opts.format !== WIRD_FORMAT_IMAGE) {
    return sendPagesAsText(bot, chatId, pages, basmala, opts.lead);
  }

  const baseUrl = config.mushafImageBaseUrl ?? null;
  const cached = await getCachedPageImageIds(pages.map((p) => p.pageNumber));

  let pagesSent = 0;
  let lastResult: SendResult = 'ok';

  // Send one page as a photo when a source resolves, else as text. Caches a new
  // file_id on success. 'blocked' stops the wird (text would be blocked too);
  // 'failed' falls back to text so a bad page never wedges the reader.
  const sendOnePage = async (page: PageContent, lead?: string): Promise<SendResult> => {
    const photo = resolvePhoto(page.pageNumber, cached, baseUrl);
    if (photo === null) {
      logger.debug('No page-image source; sending this page as text', { page: page.pageNumber });
      return sendMessages(bot, chatId, formatWird([page], basmala, lead));
    }
    const { result, fileId } = await sendPhoto(bot, chatId, photo, imageCaption(page, lead));
    if (result === 'ok') {
      await cacheFileId(page.pageNumber, fileId, cached);
      return 'ok';
    }
    if (result === 'blocked') return 'blocked';
    logger.warn('Image send failed; falling back to text for this page', { page: page.pageNumber });
    return sendMessages(bot, chatId, formatWird([page], basmala, lead));
  };

  for (const group of chunk(pages, MAX_ALBUM_SIZE)) {
    const lead = pagesSent === 0 ? opts.lead : undefined;
    const photos = group.map((p) => resolvePhoto(p.pageNumber, cached, baseUrl));

    // Album the group when it has 2+ pages and every page has a real source
    // (a page with no source must go as text, which cannot sit in a photo album).
    if (group.length >= 2 && photos.every((ph) => ph !== null)) {
      const items = group.map((p, i) => ({
        media: photos[i]!,
        caption: i === 0 ? imageCaption(p, lead) : undefined,
      }));
      const album = await sendPhotoAlbum(bot, chatId, items);
      if (album.result === 'ok') {
        await Promise.all(group.map((p, i) => cacheFileId(p.pageNumber, album.fileIds[i], cached)));
        pagesSent += group.length;
        lastResult = 'ok';
        continue;
      }
      if (album.result === 'blocked') {
        lastResult = 'blocked';
        break;
      }
      logger.warn('Album send failed; sending this group page-by-page', {
        startPage: group[0]!.pageNumber,
        count: group.length,
      });
    }

    // Per-page send: a single page, an un-albumable group, or an album that
    // failed. Each page falls back to text on its own if needed.
    let broke = false;
    for (let i = 0; i < group.length; i++) {
      lastResult = await sendOnePage(group[i]!, i === 0 ? lead : undefined);
      if (lastResult !== 'ok') {
        broke = true;
        break;
      }
      pagesSent++;
    }
    if (broke) break;
  }

  return { pagesSent, lastResult };
}

/** Send each page as a plain-text message (set), in order. */
async function sendPagesAsText(
  bot: Bot<Context>,
  chatId: bigint,
  pages: PageContent[],
  basmala: string,
  lead?: string,
): Promise<SendWirdResult> {
  let pagesSent = 0;
  let lastResult: SendResult = 'ok';
  for (let i = 0; i < pages.length; i++) {
    const messages = formatWird([pages[i]!], basmala, i === 0 ? lead : undefined);
    lastResult = await sendMessages(bot, chatId, messages);
    if (lastResult !== 'ok') break;
    pagesSent++;
  }
  return { pagesSent, lastResult };
}

// ─── Daily tajweed lesson ───────────────────────────────────────────

/** The rendered lesson to post before a subscriber's wird. */
export interface LessonView {
  /** The lesson's 0-based index in the deck (for advancing the cycle). */
  index: number;
  /** Short title, used for the audio clip's caption. */
  titleAr: string;
  /** The full lesson message text. */
  text: string;
  /** The example ayah, for resolving its audio clip. */
  example: { surah: number; ayah: number };
}

/**
 * Build the lesson at a subscriber's current position, or null when there is
 * nothing to send: the lesson is turned off, the deck is empty, or the example
 * ayah is somehow not seeded (logged, and we skip the lesson rather than block
 * the wird). The example TEXT comes from the verified database, never typed.
 */
export async function tajweedLessonView(sub: {
  tajweedEnabled: boolean;
  tajweedLessonIndex: number;
}): Promise<LessonView | null> {
  // Safety gate: never broadcast the deck while it is still pending scholarly
  // review, even though the toggle defaults on. Flip LESSONS_PENDING_REVIEW to
  // false (after review) to go live. This covers both delivery and the /tajweed
  // preview, since both build the view here.
  if (LESSONS_PENDING_REVIEW || !sub.tajweedEnabled || TAJWEED_LESSON_COUNT === 0) return null;
  const index = lessonIndexInRange(sub.tajweedLessonIndex, TAJWEED_LESSON_COUNT);
  const lesson = TAJWEED_LESSONS[index]!;
  const example = await getAyahText(lesson.example.surah, lesson.example.ayah);
  if (!example) {
    logger.error('Tajweed example ayah not seeded; skipping the lesson', {
      index,
      surah: lesson.example.surah,
      ayah: lesson.example.ayah,
    });
    return null;
  }
  return {
    index,
    titleAr: lesson.titleAr,
    text: formatLesson(lesson, example),
    example: lesson.example,
  };
}

/**
 * Render ANY lesson by its deck index, for the read-only lessons browser. Unlike
 * tajweedLessonView this is independent of any subscriber: it never reads or
 * moves a reader's daily lesson position, and it does not check the on/off
 * toggle (browsing is always allowed). The header reads "الدرس N من M" (not
 * "today's"). Returns null when the deck is empty or the example ayah is not
 * seeded. The caller still gates on LESSONS_PENDING_REVIEW.
 */
export async function renderLessonAt(index: number): Promise<string | null> {
  if (TAJWEED_LESSON_COUNT === 0) return null;
  const i = lessonIndexInRange(index, TAJWEED_LESSON_COUNT);
  const lesson = TAJWEED_LESSONS[i]!;
  const example = await getAyahText(lesson.example.surah, lesson.example.ayah);
  if (!example) {
    logger.error('Tajweed example ayah not seeded; cannot render browsed lesson', {
      index: i,
      surah: lesson.example.surah,
      ayah: lesson.example.ayah,
    });
    return null;
  }
  const header = `الدرس ${toArabicDigits(i + 1)} من ${toArabicDigits(TAJWEED_LESSON_COUNT)}`;
  return formatLesson(lesson, example, header);
}

/**
 * Send a rendered lesson: the text first, then (best effort) its example audio
 * clip. The text is the lesson; the audio is a bonus, so an audio failure is
 * logged and swallowed. Returns the TEXT's result (ok / blocked / failed) so
 * the caller advances the lesson cycle only on a real send. A blocked/failed
 * text never blocks the wird — the wird send that follows is the source of
 * truth for a blocked or unreachable subscriber.
 */
export async function sendLesson(
  bot: Bot<Context>,
  chatId: bigint,
  view: LessonView,
): Promise<SendResult> {
  const textResult = await sendMessages(bot, chatId, [view.text]);
  if (textResult !== 'ok') return textResult;

  const baseUrl = config.tajweedAudioBaseUrl;
  if (baseUrl) {
    try {
      const { surah, ayah } = view.example;
      const cachedId = await getCachedTajweedAudioId(surah, ayah);
      let audio: string | InputFile;
      if (cachedId) {
        audio = cachedId;
      } else {
        const src = tajweedAudioSource(baseUrl, surah, ayah);
        audio = isHttpSource(src) ? src : new InputFile(src);
      }
      const { result, fileId } = await sendAudio(bot, chatId, audio, {
        caption: COPY.tajweedAudioCaption(view.titleAr),
        title: COPY.tajweedAudioTitle(view.titleAr),
        performer: COPY.tajweedAudioPerformer,
        silent: true, // a quiet companion to the lesson text that just notified
      });
      if (result === 'ok' && fileId && fileId !== cachedId) {
        await cacheTajweedAudioId(surah, ayah, fileId);
      }
    } catch (err) {
      logger.warn('Tajweed example audio failed (text lesson already sent)', {
        chatId: String(chatId),
        error: String(err),
      });
    }
  }
  return 'ok';
}

/**
 * Build a single plain-text document of the WHOLE tajweed deck for review:
 * every lesson numbered, with its example ayah's verified text pulled from the
 * database, so a qualified reader can check both the explanation AND that the
 * example actually demonstrates the rule. Returned as one string; the caller
 * sends it to the admin as a document (no message-length limit), to read,
 * annotate, or forward to a مقرئ. Ignores the on/off and review gates on
 * purpose — you review the deck whether or not it is currently live.
 */
export async function buildLessonReview(): Promise<string> {
  const pad3 = (n: number) => String(n).padStart(3, '0');
  const lines: string[] = [
    'مراجعة دروس التجويد',
    '='.repeat(40),
    `عدد الدروس: ${toArabicDigits(TAJWEED_LESSON_COUNT)}`,
    LESSONS_PENDING_REVIEW
      ? 'الحالة: مسودة قيد المراجعة (لا تُرسل للقراء بعد).'
      : 'الحالة: منشورة للقراء الآن.',
    '',
    'يُرجى التحقق من: صحة الشرح، ومطابقة المثال للقاعدة، وسلامة اللغة.',
    'النص القرآني للأمثلة مأخوذ من قاعدة البيانات الموثوقة (غير مكتوب يدويًا).',
    '',
  ];
  for (let i = 0; i < TAJWEED_LESSONS.length; i++) {
    const lesson = TAJWEED_LESSONS[i]!;
    const example = await getAyahText(lesson.example.surah, lesson.example.ayah);
    lines.push('—'.repeat(40));
    lines.push(
      `الدرس ${toArabicDigits(i + 1)} من ${toArabicDigits(TAJWEED_LESSON_COUNT)}: ${lesson.titleAr}`,
    );
    lines.push('');
    lines.push(lesson.bodyAr);
    lines.push('');
    if (example) {
      lines.push(
        `المثال — سورة ${example.surahNameAr}، آية ${toArabicDigits(example.numberInSurah)}:`,
      );
      lines.push(example.text);
    } else {
      lines.push(
        `⚠️ المثال (سورة ${lesson.example.surah}، آية ${lesson.example.ayah}) غير موجود في قاعدة البيانات!`,
      );
    }
    if (lesson.exampleNote) lines.push(`ملاحظة: ${lesson.exampleNote}`);
    lines.push(`ملف الصوت: ${pad3(lesson.example.surah)}${pad3(lesson.example.ayah)}.mp3`);
    lines.push('');
  }
  return lines.join('\n');
}

// ─── Page recitation audio ──────────────────────────────────────────

/**
 * After the wird, send a recitation clip for each page in the subscriber's
 * chosen reciter (default Abdul Basit). Best effort and page-by-page: a failed
 * clip is logged and skipped, never blocking the rest or the wird. The clip is
 * fetched from the trusted source (everyayah) the first time and then re-sent
 * by cached file_id. Stops early if the chat turns out to be blocked.
 */
export async function sendPageAudio(
  bot: Bot<Context>,
  chatId: bigint,
  pages: PageContent[],
  reciter: ReciterKey,
): Promise<void> {
  for (const page of pages) {
    try {
      const cached = await getCachedPageAudioId(page.pageNumber, reciter);
      let audio: string | InputFile;
      if (cached) {
        audio = cached;
      } else {
        const src = pageAudioSource(reciter, page.pageNumber);
        audio = isHttpSource(src) ? src : new InputFile(src);
      }
      const { result, fileId } = await sendAudio(bot, chatId, audio, {
        caption: COPY.pageAudioCaption(page.pageNumber, reciter),
        title: COPY.pageAudioTitle(page.pageNumber),
        performer: reciterNameAr(reciter),
        silent: true, // a quiet companion to the wird that just notified
      });
      if (result === 'blocked') return; // the chat is blocked; stop trying
      if (result === 'ok' && fileId && fileId !== cached) {
        await cachePageAudioId(page.pageNumber, reciter, fileId);
      }
    } catch (err) {
      logger.warn('Page recitation failed (wird already sent)', {
        chatId: String(chatId),
        page: page.pageNumber,
        error: String(err),
      });
    }
  }
}

// ─── Read confirmation (the "read ✓ / next" button) ─────────────────

/**
 * Send the small "did you finish your wird?" prompt that carries the
 * "read ✓ — next" button (USERS only; the channel never advances on a read).
 * Best effort: it is the call to action, not the wird, so a failure is logged
 * and swallowed — the reader can still confirm with /next.
 */
export async function sendConfirmPrompt(
  bot: Bot<Context>,
  chatId: bigint,
  startPage: number,
): Promise<void> {
  try {
    await bot.api.sendMessage(Number(chatId), COPY.confirmPrompt, {
      reply_markup: new InlineKeyboard().text(COPY.readButton, readConfirmData(startPage)),
      // Silent: the wird itself already notified; this is its quiet companion,
      // like the recitation, so a reader is buzzed once per day, not twice.
      disable_notification: true,
    });
  } catch (err) {
    logger.warn('Could not send the read-confirmation prompt', {
      chatId: String(chatId),
      error: String(err),
    });
  }
}

/**
 * When a user's wird has gone unread for one or more days, send a gentle
 * "you have not read for N days" note with a rotating ayah about the virtue of
 * the Qur'an (its text read from the verified database, never typed). Best
 * effort and never blocks the wird. Does nothing when nothing has been missed.
 */
export async function sendMissedDaysNudge(
  bot: Bot<Context>,
  chatId: bigint,
  subscriberId: number,
  timezone: string,
  now: Date,
): Promise<void> {
  try {
    const { date: today } = getLocalContext(timezone, now);
    const missed = await countUnreadDeliveriesBefore(subscriberId, today);
    if (missed === 0) return;
    const virtue = pickQuranVirtue(missed);
    const ayah = await getAyahText(virtue.surah, virtue.ayah);
    if (!ayah) {
      // The encouragement ayah should always be seeded; if not, skip the ayah
      // rather than block the wird. (reference.test.ts guards the references.)
      logger.error('Encouragement ayah not seeded; skipping the nudge', { ...virtue });
      return;
    }
    await sendMessages(bot, chatId, [COPY.missedDaysMessage(missed, ayah)]);
  } catch (err) {
    logger.warn('Could not send the missed-days nudge', {
      chatId: String(chatId),
      error: String(err),
    });
  }
}

/**
 * Reveal a subscriber's CURRENT wird (its pages, format-aware) right now — the
 * read-ahead view after a confirmed read — WITHOUT recording a delivery. Used to
 * show the next wird from the just-advanced position (the caller attaches its
 * own "read ✓" button). `lead` titles it (e.g. "🌿 وردك التالي").
 *
 * It deliberately does NOT send the page recitation: audio is tied to a real
 * delivery (the scheduled push, or a /today that records the day), not to merely
 * showing a wird — so a reader who races ahead with /next is not buried under a
 * clip per page. It arrives with the wird's actual delivery. Returns the number
 * of pages that went out (0 when nothing could be prepared/sent).
 */
export async function sendWirdNow(
  bot: Bot<Context>,
  sub: {
    chatId: bigint;
    currentPage: number;
    wirdSize: number;
    wirdFormat: string;
  },
  lead: string,
): Promise<number> {
  const [content, basmala] = await Promise.all([
    getWird(sub.currentPage, sub.wirdSize),
    getBasmala(),
  ]);
  if (content.length === 0) return 0;
  const { pagesSent } = await sendWird(bot, sub.chatId, content, basmala, {
    lead,
    format: normalizeWirdFormat(sub.wirdFormat),
  });
  return pagesSent;
}

/**
 * The heart of the bot: find every subscriber whose wird is due right now and
 * send it. Safe to run every minute and safe to run twice for the same
 * minute, because:
 *   - dueLocalDate decides per-subscriber (their own timezone + send time).
 *   - a (subscriber, local date) record makes it send at most once per local
 *     day, even on a restart catch-up or a double cron fire.
 *   - one subscriber failing is caught and never stops the rest.
 *
 * The position advances differently per kind:
 *   - CHANNEL: advance-on-send (a broadcast, the admin sets the pace). The
 *     record carries nextPage, so the position moves with the post; a partial
 *     send advances only by the pages that went out.
 *   - USER: advance-on-READ. The send records the day but does NOT move the
 *     position (no nextPage), and a "read ✓" button rides the wird. The wird
 *     therefore repeats unchanged each day until the reader confirms, so a
 *     missed day never skips pages. A repeat carries a gentle "N days" nudge.
 */
export async function deliverDueSubscribers(
  bot: Bot<Context>,
  now: Date = new Date(),
): Promise<DeliveryStats> {
  const stats: DeliveryStats = { due: 0, sent: 0, skipped: 0, failed: 0 };
  const kinds = allowedKinds();
  if (kinds.length === 0) return stats; // nothing to serve

  const basmala = await getBasmala();
  const subscribers = await listDeliverableSubscribers(kinds);

  for (const sub of subscribers) {
    try {
      const scheduledFor = dueLocalDate(scheduleOf(sub), now);
      if (scheduledFor === null) continue; // not their day, or before their time
      stats.due++;

      if (await hasDeliveryFor(sub.id, scheduledFor)) {
        stats.skipped++; // already delivered today
        continue;
      }

      const content = await getWird(sub.currentPage, sub.wirdSize);
      if (content.length === 0) {
        // No pages resolved (a data fault, which assertQuranSeeded should
        // prevent). Never "succeed" on an empty send: that would advance the
        // position without sending anything. Log and skip; retried next tick.
        stats.failed++;
        logger.error('No wird content to send', { id: sub.id, startPage: sub.currentPage });
        continue;
      }
      // For a USER whose wird is repeating unread, lead with a gentle
      // "you have not read for N days" note + an encouragement ayah (best
      // effort). The channel does not advance-on-read, so it never repeats.
      if (sub.kind === KIND_USER) {
        await sendMissedDaysNudge(bot, sub.chatId, sub.id, sub.timezone, now);
      }

      // The daily tajweed lesson goes out right BEFORE the wird (best effort).
      // A lesson failure never blocks the wird; the wird send below remains the
      // source of truth for blocked/failed. The lesson cycle only advances when
      // the lesson actually went out AND the day is committed (below). The
      // lesson is a daily drip: it advances every send, even when the wird
      // repeats unread.
      const lesson = await tajweedLessonView(sub);
      const lessonSent = lesson ? (await sendLesson(bot, sub.chatId, lesson)) === 'ok' : false;

      // Send the wird one page at a time (text or image per the subscriber's
      // chosen format). Tracking how many pages actually went out lets a partial
      // failure advance by exactly that many: the rest roll into the next run
      // from the new position, so we never skip a page and never re-send (and so
      // duplicate) a page that already arrived.
      const lead = sub.kind === KIND_CHANNEL ? COPY.channelLead : COPY.wirdLead;
      const { pagesSent, lastResult: result } = await sendWird(bot, sub.chatId, content, basmala, {
        lead,
        format: normalizeWirdFormat(sub.wirdFormat),
      });

      if (pagesSent === 0) {
        // Nothing got through, so there is nothing to record and the position
        // does not move. A user that blocked us is marked so we stop trying; a
        // channel 403 is treated as transient (a channel never messages the bot
        // to clear a block) and simply retried next tick.
        if (result === 'blocked') {
          if (sub.kind === KIND_CHANNEL) {
            logger.error('Channel send was rejected (403); is the bot still a channel admin?', {
              id: sub.id,
            });
          } else {
            await markBlocked(sub.id);
          }
        }
        stats.failed++;
        continue;
      }

      // At least one page went out: record the day. The CHANNEL advances on the
      // send (nextPage); a USER does NOT (nextPage omitted) — its position moves
      // only on a confirmed read, so its wird repeats until then. The lesson
      // advances for both (a daily drip).
      const committed = await commitDelivery({
        subscriberId: sub.id,
        scheduledFor,
        startPage: sub.currentPage,
        pageCount: pagesSent,
        nextPage:
          sub.kind === KIND_CHANNEL ? advanceStartPage(sub.currentPage, pagesSent) : undefined,
        nextLessonIndex:
          lesson && lessonSent ? nextLessonIndex(lesson.index, TAJWEED_LESSON_COUNT) : undefined,
        startedAt: sub.startedAt,
        now,
      });
      if (committed !== 'sent') {
        stats.skipped++; // a race delivered the same day first
        continue;
      }
      stats.sent++;

      if (pagesSent < content.length) {
        // A partial wird. For the channel the unsent pages roll to the next run
        // from the advanced position; for a user the whole wird simply repeats
        // next time (the position did not move). If a USER blocked us mid-wird,
        // stop future sends AND skip the page audio + read prompt below — they
        // would only be more guaranteed-to-fail sends at a chat that just 403'd.
        logger.warn('Partial wird sent', {
          id: sub.id,
          sent: pagesSent,
          requested: content.length,
          lastResult: result,
        });
        if (result === 'blocked' && sub.kind === KIND_USER) {
          await markBlocked(sub.id);
          continue;
        }
      }

      // After the wird, send the page recitation for the pages that went out
      // (best effort; never affects the recorded delivery above).
      if (sub.wirdAudioEnabled) {
        await sendPageAudio(
          bot,
          sub.chatId,
          content.slice(0, pagesSent),
          normalizeReciter(sub.reciter),
        );
      }

      // Finally, the "read ✓ / next" button (USERS only): tapping it confirms
      // THIS wird (carried as its start page), advances, and reveals the next.
      // The channel never gets it.
      if (sub.kind === KIND_USER) await sendConfirmPrompt(bot, sub.chatId, sub.currentPage);
    } catch (err) {
      stats.failed++;
      logger.error('Delivery failed for subscriber', { id: sub.id, error: String(err) });
    }
  }

  return stats;
}

/**
 * Build the message(s) for a subscriber's CURRENT wird without sending or
 * advancing. Used by /today so a user can peek at where they are.
 */
export async function previewWird(sub: {
  currentPage: number;
  wirdSize: number;
}): Promise<string[]> {
  const [content, basmala] = await Promise.all([
    getWird(sub.currentPage, sub.wirdSize),
    getBasmala(),
  ]);
  if (content.length === 0) return [];
  return formatWird(content, basmala, COPY.wirdLead);
}

/**
 * The single page a reciter preview ("try it on today's page") should sample:
 * today's first DELIVERED page if there is one (so it matches what they last
 * received), else the subscriber's current page. Just ONE page, never the whole
 * wird, so a multi-page reader is not flooded with clips. A pure read — no
 * delivery, no advance — so the preview button can be tapped freely. Returns []
 * when no page resolves.
 */
export async function sampleAudioPagesFor(
  sub: { id: number; timezone: string; currentPage: number },
  now: Date = new Date(),
): Promise<PageContent[]> {
  const local = getLocalContext(sub.timezone, now);
  const delivered = await getDeliveryFor(sub.id, local.date);
  const startPage = delivered ? delivered.startPage : sub.currentPage;
  return getWird(startPage, 1);
}

/**
 * The page numbers of the reader's wird, for the /tafsir link(s): today's
 * DELIVERED pages if there is a delivery (so the links match what they read
 * today), else the current position's wird (`currentPage` for `wirdSize`
 * pages). Goes through getWird so the numbers are the REAL pages (clamped at
 * the end of the Mushaf), and so a changed wird size or page is always
 * reflected. A pure read — no delivery, no advance. Returns [] when none.
 */
export async function wirdPageNumbersFor(
  sub: { id: number; timezone: string; currentPage: number; wirdSize: number },
  now: Date = new Date(),
): Promise<number[]> {
  const local = getLocalContext(sub.timezone, now);
  const delivered = await getDeliveryFor(sub.id, local.date);
  const [startPage, count] = delivered
    ? [delivered.startPage, delivered.pageCount]
    : [sub.currentPage, sub.wirdSize];
  const pages = await getWird(startPage, count);
  return pages.map((p) => p.pageNumber);
}

/** What /today (and /page) shows, and whether to record it as today's delivery
 *  so the scheduler does not send the same wird again. The caller renders the
 *  pages in the subscriber's chosen format via sendWird, so the view itself
 *  stays format-agnostic. A user's position never moves on a view — only on a
 *  confirmed read — so the wird is always the LIVE portion at the current page. */
export interface TodayView {
  /** The wird's pages, in reading order, or empty when nothing can be prepared. */
  pages: PageContent[];
  /** The verified basmala bytes, passed through to the renderer. */
  basmala: string;
  /** The lead line for the first page (e.g. "🌿 وردك اليوم"). */
  lead: string;
  /**
   * Set when this view should be RECORDED as today's delivery (today is free:
   * an active day, not paused, not already delivered). The caller records it
   * after the pages are shown, so the scheduler skips the day. Recording does
   * NOT move the position (a user advances only on a confirmed read). Null on a
   * re-show, an off day, or while paused.
   */
  record: { scheduledFor: string; startPage: number; pageCount: number } | null;
  /** True when today's wird was already delivered and this is a re-show. */
  alreadyDelivered: boolean;
}

/** Fields buildTodayView needs off a subscriber row. */
export interface TodaySubscriber {
  id: number;
  timezone: string;
  activeDays: number;
  pausedAt: Date | null;
  currentPage: number;
  wirdSize: number;
}

/**
 * Decide what /today (and /page) shows and whether it counts as today's
 * delivery.
 *
 * The wird is always the LIVE portion at the reader's current page and size:
 * a view never moves the position (only a confirmed read does), so raising the
 * size or jumping with /page is reflected at once, and re-showing an
 * already-delivered day shows the same unread wird. When today is still free
 * (active day, not paused, not yet delivered), the caller RECORDS today's
 * delivery so the scheduler does not also send it — but does not advance.
 */
export async function buildTodayView(sub: TodaySubscriber, now: Date): Promise<TodayView> {
  const basmala = await getBasmala();
  const local = getLocalContext(sub.timezone, now);
  const scheduledFor = local.date;
  const delivered = await getDeliveryFor(sub.id, scheduledFor);

  const content = await getWird(sub.currentPage, sub.wirdSize);
  if (content.length === 0) {
    return {
      pages: [],
      basmala,
      lead: COPY.wirdLead,
      record: null,
      alreadyDelivered: delivered !== null,
    };
  }

  // Record today only when it is genuinely free: not already delivered, an
  // active day, and not paused. Recording does NOT move the position — the user
  // advances on a confirmed read. A re-show, off day, or paused day has nothing
  // to record.
  const recordable =
    delivered === null && sub.pausedAt === null && isDayActive(sub.activeDays, local.isoWeekday);
  const record = recordable
    ? { scheduledFor, startPage: sub.currentPage, pageCount: content.length }
    : null;
  return {
    pages: content,
    basmala,
    lead: COPY.wirdLead,
    record,
    alreadyDelivered: delivered !== null,
  };
}

/** Pull the scheduling fields the core math needs out of a subscriber row. */
function scheduleOf(sub: DeliverableSubscriber) {
  return {
    timezone: sub.timezone,
    deliveryHour: sub.deliveryHour,
    deliveryMinute: sub.deliveryMinute,
    activeDays: sub.activeDays,
  };
}
