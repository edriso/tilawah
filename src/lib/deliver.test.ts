import { describe, it, expect, beforeEach, vi } from 'vitest';

// Stub the database and send layers so the engine's orchestration can be
// tested with no real database or Telegram. The scheduling math (dueLocalDate)
// and message formatting are the real implementations.
const h = vi.hoisted(() => ({
  listDeliverableSubscribers: vi.fn(),
  hasDeliveryFor: vi.fn(),
  getWird: vi.fn(),
  getBasmala: vi.fn(),
  commitDelivery: vi.fn(),
  markBlocked: vi.fn(),
  sendMessages: vi.fn(),
}));

vi.mock('../database', () => ({
  listDeliverableSubscribers: h.listDeliverableSubscribers,
  hasDeliveryFor: h.hasDeliveryFor,
  getWird: h.getWird,
  getBasmala: h.getBasmala,
  commitDelivery: h.commitDelivery,
  markBlocked: h.markBlocked,
  KIND_USER: 'user',
  KIND_CHANNEL: 'channel',
}));
vi.mock('./send', () => ({ sendMessages: h.sendMessages }));
vi.mock('../config', () => ({ config: { userWirdEnabled: true }, channelEnabled: () => true }));
vi.mock('./logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { deliverDueSubscribers } from './deliver';

const NOW = new Date('2026-06-01T12:00:00Z');
const fakeBot = {} as never;
const CONTENT = [
  {
    pageNumber: 1,
    juz: 1,
    ayat: [{ surahNumber: 1, surahNameAr: 'الفاتحة', numberInSurah: 1, text: 'نص' }],
  },
];

// A subscriber that is due at NOW (UTC, every day, sends at 00:00).
function sub(over: Record<string, unknown> = {}) {
  return {
    id: 1,
    chatId: 123n,
    kind: 'user',
    platform: 'telegram',
    timezone: 'UTC',
    deliveryHour: 0,
    deliveryMinute: 0,
    activeDays: 127,
    wirdSize: 1,
    currentPage: 1,
    pausedAt: null,
    blockedAt: null,
    startedAt: null,
    ...over,
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.getBasmala.mockResolvedValue('بسم الله');
  h.getWird.mockResolvedValue(CONTENT);
  h.hasDeliveryFor.mockResolvedValue(false);
  h.commitDelivery.mockResolvedValue('sent');
  h.sendMessages.mockResolvedValue('ok');
});

describe('deliverDueSubscribers', () => {
  it('sends and commits a due subscriber', async () => {
    h.listDeliverableSubscribers.mockResolvedValue([sub()]);
    const stats = await deliverDueSubscribers(fakeBot, NOW);
    expect(h.sendMessages).toHaveBeenCalledOnce();
    expect(h.commitDelivery).toHaveBeenCalledOnce();
    expect(stats).toMatchObject({ due: 1, sent: 1, failed: 0, skipped: 0 });
  });

  it('does NOT advance the position on a failed send', async () => {
    h.listDeliverableSubscribers.mockResolvedValue([sub()]);
    h.sendMessages.mockResolvedValue('failed');
    const stats = await deliverDueSubscribers(fakeBot, NOW);
    expect(h.commitDelivery).not.toHaveBeenCalled();
    expect(stats).toMatchObject({ due: 1, failed: 1, sent: 0 });
  });

  it('marks a USER blocked on 403 but never a CHANNEL, and never commits', async () => {
    h.listDeliverableSubscribers.mockResolvedValue([
      sub({ id: 1, kind: 'user' }),
      sub({ id: 2, kind: 'channel' }),
    ]);
    h.sendMessages.mockResolvedValue('blocked');
    const stats = await deliverDueSubscribers(fakeBot, NOW);
    expect(h.markBlocked).toHaveBeenCalledTimes(1);
    expect(h.markBlocked).toHaveBeenCalledWith(1);
    expect(h.commitDelivery).not.toHaveBeenCalled();
    expect(stats.failed).toBe(2);
  });

  it('skips a subscriber already delivered today (no send)', async () => {
    h.listDeliverableSubscribers.mockResolvedValue([sub()]);
    h.hasDeliveryFor.mockResolvedValue(true);
    const stats = await deliverDueSubscribers(fakeBot, NOW);
    expect(h.sendMessages).not.toHaveBeenCalled();
    expect(stats).toMatchObject({ due: 1, skipped: 1, sent: 0 });
  });

  it('counts a duplicate commit (race) as skipped, not sent', async () => {
    h.listDeliverableSubscribers.mockResolvedValue([sub()]);
    h.commitDelivery.mockResolvedValue('duplicate');
    const stats = await deliverDueSubscribers(fakeBot, NOW);
    expect(stats).toMatchObject({ due: 1, skipped: 1, sent: 0 });
  });

  it('ignores a subscriber that is not due yet (before their send time)', async () => {
    h.listDeliverableSubscribers.mockResolvedValue([sub({ deliveryHour: 23 })]);
    const stats = await deliverDueSubscribers(fakeBot, NOW);
    expect(h.sendMessages).not.toHaveBeenCalled();
    expect(stats).toMatchObject({ due: 0, sent: 0 });
  });

  it('fails safe on empty content: no send, no commit, no advance', async () => {
    h.listDeliverableSubscribers.mockResolvedValue([sub()]);
    h.getWird.mockResolvedValue([]);
    const stats = await deliverDueSubscribers(fakeBot, NOW);
    expect(h.sendMessages).not.toHaveBeenCalled();
    expect(h.commitDelivery).not.toHaveBeenCalled();
    expect(stats.failed).toBe(1);
  });

  it('keeps going when one subscriber throws', async () => {
    h.listDeliverableSubscribers.mockResolvedValue([sub({ id: 1 }), sub({ id: 2 })]);
    h.getWird.mockRejectedValueOnce(new Error('boom')); // first subscriber fails
    const stats = await deliverDueSubscribers(fakeBot, NOW);
    expect(stats.failed).toBe(1);
    expect(stats.sent).toBe(1); // the second still delivered
  });
});
