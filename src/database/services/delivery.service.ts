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
 * Record a successful delivery, all in one transaction. Call this ONLY after
 * the wird was actually sent.
 *
 * `nextPage` decides whether the POSITION moves:
 *   - The CHANNEL (advance-on-send) passes `nextPage`, so its position advances
 *     with the send, exactly as before.
 *   - A USER (advance-on-read) OMITS `nextPage`, so the row is recorded but the
 *     position stays put. The user's position only moves later, on a confirmed
 *     read (`confirmRead`). The wird therefore repeats each day until confirmed,
 *     so a missed day never skips pages.
 *
 * The tajweed lesson advances on every real send (a daily drip), for both, so
 * `nextLessonIndex` is independent of `nextPage`.
 *
 * The unique (subscriber, scheduledFor) index is the idempotency lock: if a
 * second call races in for the same local day, the insert fails and we report
 * 'duplicate' without recording twice.
 */
export async function commitDelivery(params: {
  subscriberId: number;
  scheduledFor: string;
  /** The first page of the wird that was sent, for the audit log. */
  startPage: number;
  /** How many pages were sent. */
  pageCount: number;
  /** The page to move to (already wrapped). Provided by the CHANNEL to advance
   *  on send; OMITTED by a USER, whose position advances only on a read. */
  nextPage?: number;
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
          // Advance the position only when asked (the channel); a user's position
          // moves on a confirmed read, not on the send.
          ...(nextPage !== undefined ? { currentPage: nextPage } : {}),
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

export type ConfirmResult = 'advanced' | 'already';

/**
 * Confirm that a USER read the wird that starts at `fromPage`, moving them to
 * `nextPage` and marking every still-unread "sent" row read — all in one
 * transaction. Used by the "read ✓" button and /next.
 *
 * The position move is an atomic compare-and-set: `updateMany` only matches
 * while `currentPage` is still `fromPage`, so a double tap or a stale button
 * from an earlier day moves no one twice — the second call matches no row and
 * returns 'already'. This is what makes old buttons left in the chat harmless.
 */
export async function confirmRead(
  subscriberId: number,
  fromPage: number,
  nextPage: number,
  now: Date = new Date(),
): Promise<ConfirmResult> {
  // The advance and the "mark read" must be one atomic unit: if only the first
  // landed, the position would move while the just-read wird stayed unconfirmed
  // — a spurious "days not read" count until the next confirm self-healed it. An
  // interactive transaction lets us keep the compare-and-set's conditional
  // (return 'already' when no row matched) between the two writes.
  return prisma.$transaction(async (tx) => {
    // Compare-and-set: advance only if still parked at fromPage.
    const moved = await tx.subscriber.updateMany({
      where: { id: subscriberId, currentPage: fromPage },
      data: { currentPage: nextPage },
    });
    if (moved.count === 0) return 'already';
    // Mark this and any earlier unread days read, so the "days not read" count
    // resets to zero. (All unconfirmed rows are for the same fromPage wird.)
    await tx.deliveryLog.updateMany({
      where: { subscriberId, status: 'sent', confirmedAt: null },
      data: { confirmedAt: now },
    });
    return 'advanced';
  });
}

/**
 * The most recent still-unread "sent" delivery for this subscriber, or null.
 * The source of truth for the "read ✓" button: its startPage IS the user's
 * current page (the position only moves on confirm), and its pageCount is how
 * far to advance. Null means there is nothing to confirm (already read, or the
 * wird has not gone out yet).
 */
export function getLatestUnconfirmedDelivery(subscriberId: number) {
  return prisma.deliveryLog.findFirst({
    where: { subscriberId, status: 'sent', confirmedAt: null },
    orderBy: { scheduledFor: 'desc' },
    select: { startPage: true, pageCount: true },
  });
}

/**
 * How many days BEFORE `today` this subscriber was sent a wird and has not yet
 * confirmed reading it — the gentle "you haven't read for N days" number. Today
 * is excluded so the count reflects past misses, not the wird just shown.
 */
export function countUnreadDeliveriesBefore(subscriberId: number, today: string): Promise<number> {
  return prisma.deliveryLog.count({
    where: {
      subscriberId,
      status: 'sent',
      confirmedAt: null,
      scheduledFor: { lt: today },
    },
  });
}
