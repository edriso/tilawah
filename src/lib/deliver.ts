import { InputFile, type Bot, type Context } from 'grammy';
import {
  dueLocalDate,
  advanceStartPage,
  formatWird,
  pageBanner,
  getLocalContext,
  isDayActive,
  mushafImageSource,
  isHttpSource,
  normalizeWirdFormat,
  WIRD_FORMAT_IMAGE,
  type WirdFormat,
  type PageContent,
} from '../core';
import {
  listDeliverableSubscribers,
  hasDeliveryFor,
  getDeliveryFor,
  getWird,
  getBasmala,
  commitDelivery,
  markBlocked,
  getCachedPageImageIds,
  cachePageImageId,
  KIND_USER,
  KIND_CHANNEL,
  type DeliverableSubscriber,
} from '../database';
import { config, channelEnabled } from '../config';
import { sendMessages, type SendResult } from './send';
import { sendPhoto } from './send-photo';
import { COPY } from './copy';
import { logger } from './logger';

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

/**
 * Send a wird (one or more pages) to a chat, ONE page at a time, in either
 * text or image format. Sending per page (not as one album) keeps the
 * partial-failure contract identical for both formats: the caller advances the
 * position by exactly `pagesSent`, so a mid-wird failure never skips a page nor
 * re-sends one that already arrived.
 *
 * Image format sends each page as a photo. The first time a page is sent we let
 * Telegram fetch it from the configured source URL, then cache the file_id it
 * returns so every later send is a cheap reference. If the image format is
 * requested but no source is configured (and the page is not yet cached), we
 * fall back to text for that page: the holy text always goes out, never an
 * empty or skipped send.
 */
export async function sendWird(
  bot: Bot<Context>,
  chatId: bigint,
  pages: PageContent[],
  basmala: string,
  opts: SendWirdOptions,
): Promise<SendWirdResult> {
  const useImage = opts.format === WIRD_FORMAT_IMAGE;
  const baseUrl = config.mushafImageBaseUrl ?? null;
  // One lookup of the cached file_ids for the whole wird (image format only).
  const cached = useImage
    ? await getCachedPageImageIds(pages.map((p) => p.pageNumber))
    : new Map<number, string>();

  let pagesSent = 0;
  let lastResult: SendResult = 'ok';

  for (let i = 0; i < pages.length; i++) {
    const page = pages[i]!;
    const lead = i === 0 ? opts.lead : undefined;

    if (useImage) {
      const cachedId = cached.get(page.pageNumber);
      const built = baseUrl ? mushafImageSource(baseUrl, page.pageNumber) : null;
      // What to send: a cached file_id (Telegram resends), an http URL (Telegram
      // fetches it), or a local file the bot uploads itself (InputFile) for
      // self-hosted images on a bot with no public URL.
      const photo: string | InputFile | null = cachedId
        ? cachedId
        : built === null
          ? null
          : isHttpSource(built)
            ? built
            : new InputFile(built);
      if (photo !== null) {
        const banner = pageBanner(page);
        const caption = lead ? `${lead}\n\n${banner}` : banner;
        const { result, fileId } = await sendPhoto(bot, chatId, photo, caption);
        if (result === 'ok') {
          // Cache the file_id only when we sent by URL (or it changed), so later
          // sends reference it instead of re-fetching the source.
          if (fileId && fileId !== cachedId) {
            try {
              await cachePageImageId(page.pageNumber, fileId);
            } catch (err) {
              logger.warn('Could not cache page image file_id', {
                page: page.pageNumber,
                error: String(err),
              });
            }
          }
          lastResult = 'ok';
          pagesSent++;
          continue;
        }
        if (result === 'blocked') {
          // The chat blocked the bot; a text send would be blocked too. Stop and
          // let the caller mark them blocked.
          lastResult = 'blocked';
          break;
        }
        // result === 'failed': this page could not be sent as a photo (a page
        // missing from the source, a non-image URL, or over Telegram's size
        // limit). Fall through to TEXT for this page so a bad source can never
        // wedge a subscriber (or the channel) on it forever: the holy text still
        // goes out and the position advances. A warning so a broken source is
        // visible. (A genuine Telegram outage fails the text send below too, so
        // nothing is sent and it is simply retried next run.)
        logger.warn('Image send failed; falling back to text for this page', {
          page: page.pageNumber,
        });
      } else {
        // No source configured at all: expected when images are simply not set
        // up. Debug, not warn, since with image as the default it would
        // otherwise log for every page of every send.
        logger.debug('No page-image source; sending this page as text', {
          page: page.pageNumber,
        });
      }
    }

    const messages = formatWird([page], basmala, lead);
    lastResult = await sendMessages(bot, chatId, messages);
    if (lastResult !== 'ok') break;
    pagesSent++;
  }

  return { pagesSent, lastResult };
}

/**
 * The heart of the bot: find every subscriber whose wird is due right now and
 * send it. Safe to run every minute and safe to run twice for the same
 * minute, because:
 *   - dueLocalDate decides per-subscriber (their own timezone + send time).
 *   - a (subscriber, local date) record makes it send at most once per local
 *     day, even on a restart catch-up or a double cron fire.
 *   - one subscriber failing is caught and never stops the rest.
 *   - the page advances only by the pages that were actually sent (the wird
 *     goes out one page at a time), so a partial failure neither skips pages
 *     nor re-sends pages that already arrived; the rest roll to the next run.
 *
 * The channel is just another subscriber, so it flows through this same loop.
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

      // At least one page went out: record exactly how many and advance by that
      // many, in one transaction.
      const committed = await commitDelivery({
        subscriberId: sub.id,
        scheduledFor,
        startPage: sub.currentPage,
        pageCount: pagesSent,
        nextPage: advanceStartPage(sub.currentPage, pagesSent),
        startedAt: sub.startedAt,
        now,
      });
      if (committed !== 'sent') {
        stats.skipped++; // a race delivered the same day first
        continue;
      }
      stats.sent++;

      if (pagesSent < content.length) {
        // A partial wird: the unsent pages go out on the next run from the
        // advanced position. If a USER blocked us mid-wird, stop future sends.
        logger.warn('Partial wird sent; remaining pages roll to the next run', {
          id: sub.id,
          sent: pagesSent,
          requested: content.length,
          lastResult: result,
        });
        if (result === 'blocked' && sub.kind === KIND_USER) await markBlocked(sub.id);
      }
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

/** What /today should send the user, and whether to record it as the day's
 *  delivery so the scheduler does not send the same wird again. The caller
 *  renders the pages in the subscriber's chosen format (text or image) via
 *  sendWird, so the view itself stays format-agnostic. */
export interface TodayView {
  /** The wird's pages, in reading order, or empty when nothing can be prepared. */
  pages: PageContent[];
  /** The verified basmala bytes, passed through to the renderer. */
  basmala: string;
  /** The lead line for the first page (e.g. "🌿 وردك اليوم"). */
  lead: string;
  /**
   * Set when this view should be COMMITTED as today's delivery (the user pulled
   * their wird before the scheduled send). The caller records it after the
   * pages are actually shown, so the scheduler skips the day. Null on an off
   * day or while paused (nothing is scheduled to dedupe against), and null when
   * today was already delivered (re-show only).
   */
  claim: { scheduledFor: string; startPage: number; pageCount: number; nextPage: number } | null;
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
 * Decide what /today shows and whether it counts as today's delivery.
 *
 * /today is "give me today's wird now". If the user pulls it on an active day
 * before the scheduled send, that pull IS today's delivery: we show the wird
 * and the caller records it (so the 06:00 scheduler does not send it again).
 * If today was already delivered (by an earlier /today or the scheduler), we
 * re-show exactly what was delivered without advancing. On an off day or while
 * paused there is no scheduled send to dedupe against, so /today stays a pure
 * peek that never advances.
 */
export async function buildTodayView(
  sub: TodaySubscriber,
  now: Date,
  opts: { reposition?: boolean } = {},
): Promise<TodayView> {
  const basmala = await getBasmala();
  const local = getLocalContext(sub.timezone, now);
  const scheduledFor = local.date;
  const delivered = await getDeliveryFor(sub.id, scheduledFor);

  // /today on an already-delivered day re-shows exactly what was delivered. A
  // reposition (/page) instead always shows the NEW page the user just set, so
  // it skips this re-show and renders the current position below.
  if (delivered && !opts.reposition) {
    const content = await getWird(delivered.startPage, delivered.pageCount);
    return {
      pages: content,
      basmala,
      lead: COPY.wirdLead,
      claim: null,
      alreadyDelivered: true,
    };
  }

  // Show the current position's wird.
  const content = await getWird(sub.currentPage, sub.wirdSize);
  if (content.length === 0) {
    return {
      pages: [],
      basmala,
      lead: COPY.wirdLead,
      claim: null,
      alreadyDelivered: delivered !== null,
    };
  }

  // Claim it as today's delivery only when today is genuinely free: not already
  // delivered, an active day, and not paused. A reposition on an
  // already-delivered (or off / paused) day just shows the new wird as a
  // preview and leaves today's record and the position untouched.
  const claimable =
    delivered === null && sub.pausedAt === null && isDayActive(sub.activeDays, local.isoWeekday);
  const claim = claimable
    ? {
        scheduledFor,
        startPage: sub.currentPage,
        pageCount: content.length,
        nextPage: advanceStartPage(sub.currentPage, content.length),
      }
    : null;
  return {
    pages: content,
    basmala,
    lead: COPY.wirdLead,
    claim,
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
