import { describe, it, expect, vi, beforeEach } from 'vitest';

// The scheduler's in-process lock (deliveryRunning) is the only guard that stops
// two delivery BATCHES from overlapping and double-sending between the cron tick
// and the startup catch-up. It is load-bearing for the no-double-send guarantee,
// so we test it directly. We mock the delivery engine so we control its timing.
const h = vi.hoisted(() => ({
  deliverDueSubscribers: vi.fn(),
}));

vi.mock('./lib/deliver', () => ({
  deliverDueSubscribers: h.deliverDueSubscribers,
}));
vi.mock('./lib/pending', () => ({ sweepPending: vi.fn() }));
vi.mock('./lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { runDeliveryOnce } from './scheduler';

const STATS = { due: 1, sent: 1, skipped: 0, failed: 0 };
const fakeBot = {} as never;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('runDeliveryOnce (the overlap lock)', () => {
  it('skips a trigger that fires while a batch is still in flight, and runs the engine once', async () => {
    // A batch that does not resolve until we release it, so the second trigger
    // arrives mid-flight (the exact overlap the lock exists to prevent).
    let release!: () => void;
    h.deliverDueSubscribers.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve(STATS);
        }),
    );

    const first = runDeliveryOnce(fakeBot);
    const second = await runDeliveryOnce(fakeBot); // fires while the first is running

    expect(second).toBeNull(); // skipped: a run was already active
    expect(h.deliverDueSubscribers).toHaveBeenCalledTimes(1); // the engine ran once, not twice

    release();
    await expect(first).resolves.toEqual(STATS);
  });

  it('releases the lock so a later, non-overlapping trigger runs again', async () => {
    h.deliverDueSubscribers.mockResolvedValue(STATS);

    await runDeliveryOnce(fakeBot);
    await runDeliveryOnce(fakeBot);

    expect(h.deliverDueSubscribers).toHaveBeenCalledTimes(2);
  });

  it('releases the lock even when the engine throws, so the loop is not wedged', async () => {
    h.deliverDueSubscribers.mockRejectedValueOnce(new Error('boom'));
    await expect(runDeliveryOnce(fakeBot)).rejects.toThrow('boom');

    // The finally block cleared the lock, so the next trigger is not skipped.
    h.deliverDueSubscribers.mockResolvedValue(STATS);
    const next = await runDeliveryOnce(fakeBot);
    expect(next).toEqual(STATS);
  });
});
