import type { Bot, Context } from 'grammy';
import { dueLocalDate, advanceStartPage, formatWird, getLocalContext, isDayActive } from '../core';
import {
  listDeliverableSubscribers,
  hasDeliveryFor,
  getDeliveryFor,
  getWird,
  getBasmala,
  commitDelivery,
  markBlocked,
  KIND_USER,
  KIND_CHANNEL,
  type DeliverableSubscriber,
} from '../database';
import { config, channelEnabled } from '../config';
import { sendMessages, type SendResult } from './send';
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
      // Send the wird one page at a time. Tracking how many pages actually went
      // out lets a partial failure advance by exactly that many: the rest roll
      // into the next run from the new position, so we never skip a page and
      // never re-send (and so duplicate) a page that already arrived.
      const lead = sub.kind === KIND_CHANNEL ? COPY.channelLead : COPY.wirdLead;
      let pagesSent = 0;
      let result: SendResult = 'ok';
      for (let i = 0; i < content.length; i++) {
        const pageMessages = formatWird([content[i]], basmala, i === 0 ? lead : undefined);
        result = await sendMessages(bot, sub.chatId, pageMessages);
        if (result !== 'ok') break;
        pagesSent++;
      }

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
 *  delivery so the scheduler does not send the same wird again. */
export interface TodayView {
  /** The messages to reply (the wird), or empty when nothing can be prepared. */
  messages: string[];
  /**
   * Set when this view should be COMMITTED as today's delivery (the user pulled
   * their wird before the scheduled send). The caller records it after the
   * messages are actually shown, so the scheduler skips the day. Null on an off
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
      messages: formatWird(content, basmala, COPY.wirdLead),
      claim: null,
      alreadyDelivered: true,
    };
  }

  // Show the current position's wird.
  const content = await getWird(sub.currentPage, sub.wirdSize);
  if (content.length === 0) {
    return { messages: [], claim: null, alreadyDelivered: delivered !== null };
  }
  const messages = formatWird(content, basmala, COPY.wirdLead);

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
  return { messages, claim, alreadyDelivered: delivered !== null };
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
