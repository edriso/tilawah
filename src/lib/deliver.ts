import type { Bot, Context } from 'grammy';
import { dueLocalDate, advanceStartPage, formatWird } from '../core';
import {
  listDeliverableSubscribers,
  hasDeliveryFor,
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

/** Pull the scheduling fields the core math needs out of a subscriber row. */
function scheduleOf(sub: DeliverableSubscriber) {
  return {
    timezone: sub.timezone,
    deliveryHour: sub.deliveryHour,
    deliveryMinute: sub.deliveryMinute,
    activeDays: sub.activeDays,
  };
}
