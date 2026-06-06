import { prisma } from '../client';

// The fields the send loop reads off a subscriber. Everything it needs lives
// on the row (timezone, schedule, wird size, current page), so no joins.
export type DeliverableSubscriber = Awaited<ReturnType<typeof listDeliverableSubscribers>>[number];

/**
 * Every subscriber the bot may send to right now: active (not on a break) and
 * reachable (not blocked). `kinds` limits which kinds to include, so a
 * channel-only deployment can skip USER rows. The caller still checks each
 * one's own send time and timezone before delivering.
 */
export function listDeliverableSubscribers(kinds: string[]) {
  return prisma.subscriber.findMany({
    where: { pausedAt: null, blockedAt: null, kind: { in: kinds } },
  });
}

/** True if this subscriber already has a delivery for the given local date. */
export async function hasDeliveryFor(subscriberId: number, scheduledFor: string): Promise<boolean> {
  const found = await prisma.deliveryLog.findUnique({
    where: { subscriberId_scheduledFor: { subscriberId, scheduledFor } },
    select: { id: true },
  });
  return found !== null;
}

/**
 * The delivery already recorded for this subscriber's local date, or null.
 * Used by /today to re-show exactly what was delivered (its start page and how
 * many pages) without advancing again.
 */
export function getDeliveryFor(subscriberId: number, scheduledFor: string) {
  return prisma.deliveryLog.findUnique({
    where: { subscriberId_scheduledFor: { subscriberId, scheduledFor } },
    select: { startPage: true, pageCount: true },
  });
}

export type CommitResult = 'sent' | 'duplicate';

/**
 * Record a successful delivery and move the subscriber forward to the next
 * page, all in one transaction. Call this ONLY after the wird was actually
 * sent, so a failed send never advances the page (the reader would silently
 * skip pages otherwise).
 *
 * The unique (subscriber, scheduledFor) index is the idempotency lock: if a
 * second call races in for the same local day, the insert fails and we report
 * 'duplicate' without advancing twice.
 */
export async function commitDelivery(params: {
  subscriberId: number;
  scheduledFor: string;
  /** The first page of the wird that was sent, for the audit log. */
  startPage: number;
  /** How many pages were sent. */
  pageCount: number;
  /** The page the subscriber should be on next (already wrapped if needed). */
  nextPage: number;
  /** The subscriber's current startedAt, so we stamp it only the first time. */
  startedAt: Date | null;
  /** When the day's tajweed lesson was sent, the index to advance to (already
   *  wrapped). Omitted when no lesson was sent, so the lesson position only
   *  moves on a real lesson send — in the same transaction as the wird. */
  nextLessonIndex?: number;
  now?: Date;
}): Promise<CommitResult> {
  const { subscriberId, scheduledFor, startPage, pageCount, nextPage, startedAt, nextLessonIndex } =
    params;
  const now = params.now ?? new Date();

  try {
    await prisma.$transaction([
      prisma.deliveryLog.create({
        data: { subscriberId, scheduledFor, startPage, pageCount, status: 'sent', sentAt: now },
      }),
      prisma.subscriber.update({
        where: { id: subscriberId },
        data: {
          currentPage: nextPage,
          // Advance the lesson only when one was sent this delivery.
          ...(nextLessonIndex !== undefined ? { tajweedLessonIndex: nextLessonIndex } : {}),
          // Stamp the "member since" time on the very first delivery only.
          ...(startedAt === null ? { startedAt: now } : {}),
        },
      }),
    ]);
    return 'sent';
  } catch (err) {
    if ((err as { code?: string }).code === 'P2002') return 'duplicate';
    throw err;
  }
}
