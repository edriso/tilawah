import { describe, it, expect, beforeEach, vi } from 'vitest';

// Stub the Prisma client. getSubscriberStats is a set of parallel COUNTs (in a
// fixed order) plus one groupBy and the delivery count; we feed those in order
// and assert the derived shape (textFmt, the riwayah map).
const h = vi.hoisted(() => ({ count: vi.fn(), groupBy: vi.fn(), deliveryCount: vi.fn() }));
vi.mock('../client', () => ({
  prisma: {
    subscriber: { count: h.count, groupBy: h.groupBy },
    deliveryLog: { count: h.deliveryCount },
  },
}));

import { getSubscriberStats } from './subscriber.service';

beforeEach(() => vi.clearAllMocks());

describe('getSubscriberStats', () => {
  it('aggregates the counts, derives textFmt, and maps riwayah', async () => {
    // Call order in the Promise.all: channels, users, active, paused, blocked,
    // started, imageFmt, audioOn, tajweedOn.
    h.count
      .mockResolvedValueOnce(1) // channels
      .mockResolvedValueOnce(10) // users
      .mockResolvedValueOnce(9) // active
      .mockResolvedValueOnce(1) // paused
      .mockResolvedValueOnce(0) // blocked
      .mockResolvedValueOnce(10) // started
      .mockResolvedValueOnce(9) // imageFmt
      .mockResolvedValueOnce(10) // audioOn
      .mockResolvedValueOnce(4); // tajweedOn
    h.groupBy.mockResolvedValue([
      { riwayah: 'hafs', _count: { _all: 8 } },
      { riwayah: 'warsh-asbahani', _count: { _all: 2 } },
    ]);
    h.deliveryCount.mockResolvedValue(109);

    const s = await getSubscriberStats();

    expect(s).toMatchObject({
      channels: 1,
      users: 10,
      active: 9,
      paused: 1,
      blocked: 0,
      started: 10,
      imageFmt: 9,
      textFmt: 1, // users - imageFmt
      audioOn: 10,
      tajweedOn: 4,
      deliveries: 109,
    });
    expect(s.riwayah).toEqual({ hafs: 8, 'warsh-asbahani': 2 });
    // Users are counted with kind=user; the channel is excluded from the user total.
    expect(h.count).toHaveBeenCalledWith({ where: { kind: 'user' } });
  });

  it('handles an empty bot (no users, no riwayat)', async () => {
    h.count.mockResolvedValue(0);
    h.groupBy.mockResolvedValue([]);
    h.deliveryCount.mockResolvedValue(0);
    const s = await getSubscriberStats();
    expect(s.users).toBe(0);
    expect(s.textFmt).toBe(0);
    expect(s.riwayah).toEqual({});
  });
});
