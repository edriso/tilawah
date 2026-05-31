import type { Bot, Context } from 'grammy';
import { dueLocalDate, pagesForWird, advanceStartPage, formatWird } from '@tilawa/core';
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
} from '@tilawa/database';
import { config, channelEnabled } from '../config';
import { sendMessages } from './send';
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
 *   - the page only advances AFTER a successful send, so a failed send
 *     re-sends the same pages next time instead of skipping them.
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

      const pages = pagesForWird(sub.currentPage, sub.wirdSize);
      const content = await getWird(sub.currentPage, sub.wirdSize);
      const lead = sub.kind === KIND_CHANNEL ? COPY.channelLead : COPY.wirdLead;
      const result = await sendMessages(bot, sub.chatId, formatWird(content, basmala, lead));

      if (result === 'blocked') {
        await markBlocked(sub.id);
        stats.failed++;
        continue;
      }
      if (result === 'failed') {
        stats.failed++;
        continue; // do NOT advance; retried next tick
      }

      const committed = await commitDelivery({
        subscriberId: sub.id,
        scheduledFor,
        startPage: sub.currentPage,
        pageCount: pages.length,
        nextPage: advanceStartPage(sub.currentPage, sub.wirdSize),
        startedAt: sub.startedAt,
        now,
      });
      if (committed === 'sent') stats.sent++;
      else stats.skipped++; // a race delivered the same day first
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
