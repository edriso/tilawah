import { prisma } from '../client';
import { ALL_DAYS } from '../../core';

// The kinds and platforms a subscriber row can have. We avoid Prisma enums; a
// short string with a known set keeps migrations simple.
export const KIND_USER = 'user';
export const KIND_CHANNEL = 'channel';
export const PLATFORM_TELEGRAM = 'telegram';

/** Find a subscriber by platform + chat id, or null if new. */
export function getByChatId(chatId: bigint, platform = PLATFORM_TELEGRAM) {
  return prisma.subscriber.findUnique({
    where: { platform_chatId: { platform, chatId } },
  });
}

/** The single channel subscriber row, or null if no channel exists yet. */
export function getChannelSubscriber(platform = PLATFORM_TELEGRAM) {
  return prisma.subscriber.findFirst({ where: { kind: KIND_CHANNEL, platform } });
}

/**
 * Make sure a subscriber row exists for this chat, creating it with defaults
 * on first contact. For a USER, any interaction also clears blockedAt (the
 * message proves we can reach them again). Uses an upsert so two messages
 * arriving at once for a brand-new chat can never race into a duplicate-key
 * error; the rare MySQL select-then-insert race is caught and retried.
 */
export async function ensureSubscriber(params: {
  chatId: bigint;
  kind: string;
  platform?: string;
  timezone?: string;
}) {
  const { chatId, kind, platform = PLATFORM_TELEGRAM, timezone } = params;
  try {
    return await prisma.subscriber.upsert({
      where: { platform_chatId: { platform, chatId } },
      // Any interaction proves a user is reachable again. (A channel is never
      // marked blocked, so this is a harmless no-op for it.)
      update: { blockedAt: null },
      create: {
        chatId,
        kind,
        platform,
        activeDays: ALL_DAYS,
        ...(timezone ? { timezone } : {}),
      },
    });
  } catch (err) {
    if ((err as { code?: string }).code === 'P2002') {
      return prisma.subscriber.update({
        where: { platform_chatId: { platform, chatId } },
        data: { blockedAt: null },
      });
    }
    throw err;
  }
}

/** Convenience: ensure a USER subscriber. */
export function ensureUser(chatId: bigint, timezone?: string) {
  return ensureSubscriber({ chatId, kind: KIND_USER, timezone });
}

/** Convenience: ensure the CHANNEL subscriber. */
export function ensureChannel(chatId: bigint, timezone?: string) {
  return ensureSubscriber({ chatId, kind: KIND_CHANNEL, timezone });
}

/** Update how many pages a subscriber gets per day. Caller clamps to 1..20. */
export function setWirdSize(subscriberId: number, wirdSize: number) {
  return prisma.subscriber.update({ where: { id: subscriberId }, data: { wirdSize } });
}

/**
 * Set the next page a subscriber will receive (1..604). Used by the channel
 * admin "last page read" command (which passes the page AFTER the one read)
 * and could reposition a user too. Caller validates the range.
 */
export function setCurrentPage(subscriberId: number, currentPage: number) {
  return prisma.subscriber.update({ where: { id: subscriberId }, data: { currentPage } });
}

/**
 * Flip one weekday on/off and return the new mask. The toggle is a single
 * atomic `active_days = active_days ^ bit` UPDATE at the database, so two fast
 * taps on the day picker can never lose each other's change the way an
 * app-side read-modify-write would. `isoWeekday` is 1 (Monday) .. 7 (Sunday);
 * bit (isoWeekday - 1) matches the mask layout in src/core/days.ts.
 */
export async function toggleActiveDay(subscriberId: number, isoWeekday: number): Promise<number> {
  if (!Number.isInteger(isoWeekday) || isoWeekday < 1 || isoWeekday > 7) {
    throw new Error(`isoWeekday must be 1..7, got ${isoWeekday}`);
  }
  const bit = 1 << (isoWeekday - 1);
  await prisma.$executeRaw`UPDATE subscribers SET active_days = active_days ^ ${bit} WHERE id = ${subscriberId}`;
  const row = await prisma.subscriber.findUniqueOrThrow({
    where: { id: subscriberId },
    select: { activeDays: true },
  });
  return row.activeDays;
}

/** Update the daily send time (local hour and minute). */
export function setDeliveryTime(subscriberId: number, hour: number, minute: number) {
  return prisma.subscriber.update({
    where: { id: subscriberId },
    data: { deliveryHour: hour, deliveryMinute: minute },
  });
}

/** Update the subscriber's IANA timezone. */
export function setTimezone(subscriberId: number, timezone: string) {
  return prisma.subscriber.update({ where: { id: subscriberId }, data: { timezone } });
}

/**
 * Mark a subscriber unreachable (they blocked the bot, or a send failed with
 * 403). Send loops skip blocked subscribers. Cleared the next time a user
 * messages the bot (see ensureSubscriber).
 */
export function markBlocked(subscriberId: number) {
  return prisma.subscriber.update({ where: { id: subscriberId }, data: { blockedAt: new Date() } });
}
