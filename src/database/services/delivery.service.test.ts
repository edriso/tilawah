import { describe, it, expect, beforeEach, vi } from 'vitest';

// The delivery service is the only place the read-gated rules touch the
// database (record without advancing, the confirm compare-and-set, the
// missed-day count). Mock the Prisma client so the SQL-shaped logic can be
// asserted without a real database.
const h = vi.hoisted(() => ({
  subUpdate: vi.fn(),
  subUpdateMany: vi.fn(),
  logCreate: vi.fn(),
  logUpdateMany: vi.fn(),
  logFindFirst: vi.fn(),
  logCount: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock('../client', () => ({
  prisma: {
    subscriber: { update: h.subUpdate, updateMany: h.subUpdateMany },
    deliveryLog: {
      create: h.logCreate,
      updateMany: h.logUpdateMany,
      findFirst: h.logFindFirst,
      count: h.logCount,
    },
    // commitDelivery wraps two ops in a transaction; just run them.
    $transaction: h.transaction,
  },
}));

import {
  commitDelivery,
  confirmRead,
  getLatestUnconfirmedDelivery,
  countUnreadDeliveriesBefore,
} from './delivery.service';

const NOW = new Date('2026-06-18T06:00:00Z');

beforeEach(() => {
  vi.clearAllMocks();
  h.subUpdate.mockResolvedValue({});
  h.logCreate.mockResolvedValue({});
  h.logUpdateMany.mockResolvedValue({ count: 1 });
  // $transaction takes two shapes here: the array form (commitDelivery) runs the
  // batched writes together; the interactive callback form (confirmRead) is given
  // a `tx` client. Map `tx` back to the same mocks so call assertions still see
  // every write, whichever form the code under test used.
  h.transaction.mockImplementation((arg: unknown) => {
    if (typeof arg === 'function') {
      return (arg as (tx: unknown) => unknown)({
        subscriber: { update: h.subUpdate, updateMany: h.subUpdateMany },
        deliveryLog: {
          create: h.logCreate,
          updateMany: h.logUpdateMany,
          findFirst: h.logFindFirst,
          count: h.logCount,
        },
      });
    }
    return Promise.all(arg as Promise<unknown>[]);
  });
});

describe('commitDelivery', () => {
  it('advances the position when nextPage is given (the channel path)', async () => {
    const res = await commitDelivery({
      subscriberId: 1,
      scheduledFor: '2026-06-18',
      startPage: 10,
      pageCount: 2,
      nextPage: 12,
      startedAt: new Date(),
      now: NOW,
    });
    expect(res).toBe('sent');
    expect(h.subUpdate.mock.calls[0][0].data).toMatchObject({ currentPage: 12 });
  });

  it('records WITHOUT moving the position when nextPage is omitted (the user path)', async () => {
    await commitDelivery({
      subscriberId: 1,
      scheduledFor: '2026-06-18',
      startPage: 10,
      pageCount: 1,
      startedAt: new Date(),
      now: NOW,
    });
    expect(h.logCreate).toHaveBeenCalledOnce();
    expect(h.subUpdate.mock.calls[0][0].data).not.toHaveProperty('currentPage');
  });

  it('stamps startedAt only on the first delivery, and advances the lesson when given', async () => {
    await commitDelivery({
      subscriberId: 1,
      scheduledFor: '2026-06-18',
      startPage: 10,
      pageCount: 1,
      nextLessonIndex: 3,
      startedAt: null,
      now: NOW,
    });
    const data = h.subUpdate.mock.calls[0][0].data;
    expect(data).toMatchObject({ tajweedLessonIndex: 3, startedAt: NOW });
  });

  it('reports a duplicate (the per-day unique lock) instead of throwing', async () => {
    h.transaction.mockRejectedValueOnce({ code: 'P2002' });
    const res = await commitDelivery({
      subscriberId: 1,
      scheduledFor: '2026-06-18',
      startPage: 10,
      pageCount: 1,
      startedAt: new Date(),
      now: NOW,
    });
    expect(res).toBe('duplicate');
  });
});

describe('confirmRead (the read compare-and-set)', () => {
  it('advances and marks every unread day read when still parked at fromPage', async () => {
    h.subUpdateMany.mockResolvedValue({ count: 1 }); // matched: position was fromPage
    const res = await confirmRead(7, 10, 11, NOW);
    expect(res).toBe('advanced');
    // Compare-and-set guards on the current page being fromPage.
    expect(h.subUpdateMany.mock.calls[0][0]).toMatchObject({
      where: { id: 7, currentPage: 10 },
      data: { currentPage: 11 },
    });
    // All unconfirmed sent rows are marked read.
    expect(h.logUpdateMany).toHaveBeenCalledWith({
      where: { subscriberId: 7, status: 'sent', confirmedAt: null },
      data: { confirmedAt: NOW },
    });
    // Atomicity: the advance and the "mark read" run inside one interactive
    // transaction (a callback), so a crash can never leave the position moved
    // while the wird stays unconfirmed.
    expect(h.transaction).toHaveBeenCalledTimes(1);
    expect(typeof h.transaction.mock.calls[0][0]).toBe('function');
  });

  it('is a no-op ("already") when the position already moved (stale/double tap)', async () => {
    h.subUpdateMany.mockResolvedValue({ count: 0 }); // no row matched fromPage
    const res = await confirmRead(7, 10, 11, NOW);
    expect(res).toBe('already');
    expect(h.logUpdateMany).not.toHaveBeenCalled(); // nothing marked, no double-advance
  });
});

describe('getLatestUnconfirmedDelivery / countUnreadDeliveriesBefore', () => {
  it('reads the most recent unconfirmed sent delivery', async () => {
    h.logFindFirst.mockResolvedValue({ startPage: 10, pageCount: 2 });
    const latest = await getLatestUnconfirmedDelivery(7);
    expect(latest).toEqual({ startPage: 10, pageCount: 2 });
    expect(h.logFindFirst.mock.calls[0][0]).toMatchObject({
      where: { subscriberId: 7, status: 'sent', confirmedAt: null },
      orderBy: { scheduledFor: 'desc' },
    });
  });

  it('counts unconfirmed sent days strictly before today', async () => {
    h.logCount.mockResolvedValue(3);
    const n = await countUnreadDeliveriesBefore(7, '2026-06-18');
    expect(n).toBe(3);
    expect(h.logCount.mock.calls[0][0]).toMatchObject({
      where: {
        subscriberId: 7,
        status: 'sent',
        confirmedAt: null,
        scheduledFor: { lt: '2026-06-18' },
      },
    });
  });
});
