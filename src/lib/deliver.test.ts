import { describe, it, expect, beforeEach, vi } from 'vitest';

// Stub the database and send layers so the engine's orchestration can be
// tested with no real database or Telegram. The scheduling math (dueLocalDate)
// and message formatting are the real implementations.
const h = vi.hoisted(() => ({
  listDeliverableSubscribers: vi.fn(),
  hasDeliveryFor: vi.fn(),
  getDeliveryFor: vi.fn(),
  getWird: vi.fn(),
  getBasmala: vi.fn(),
  commitDelivery: vi.fn(),
  markBlocked: vi.fn(),
  sendMessages: vi.fn(),
}));

vi.mock('../database', () => ({
  listDeliverableSubscribers: h.listDeliverableSubscribers,
  hasDeliveryFor: h.hasDeliveryFor,
  getDeliveryFor: h.getDeliveryFor,
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

import { deliverDueSubscribers, buildTodayView } from './deliver';
import { advanceStartPage } from '../core';

const NOW = new Date('2026-06-01T12:00:00Z');
const fakeBot = {} as never;
const CONTENT = [
  {
    pageNumber: 1,
    juz: 1,
    ayat: [{ surahNumber: 1, surahNameAr: 'الفاتحة', numberInSurah: 1, text: 'نص' }],
  },
];

// A two-page wird, for the partial-send cases.
const TWO_PAGES = [
  {
    pageNumber: 1,
    juz: 1,
    ayat: [{ surahNumber: 1, surahNameAr: 'الفاتحة', numberInSurah: 1, text: 'نص' }],
  },
  {
    pageNumber: 2,
    juz: 1,
    ayat: [{ surahNumber: 2, surahNameAr: 'البقرة', numberInSurah: 1, text: 'نص' }],
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
  h.getDeliveryFor.mockResolvedValue(null);
  h.commitDelivery.mockResolvedValue('sent');
  h.sendMessages.mockResolvedValue('ok');
});

// NOW (2026-06-01, UTC) is a Monday, ISO weekday 1.
describe('buildTodayView (/today claims today)', () => {
  const todaySub = (over: Record<string, unknown> = {}) => ({
    id: 1,
    timezone: 'UTC',
    activeDays: 127,
    pausedAt: null,
    currentPage: 5,
    wirdSize: 1,
    ...over,
  });

  it('claims today on an active, unpaused, not-yet-delivered day', async () => {
    const view = await buildTodayView(todaySub(), NOW);
    expect(view.alreadyDelivered).toBe(false);
    expect(view.messages.length).toBeGreaterThan(0);
    expect(view.claim).toEqual({
      scheduledFor: '2026-06-01',
      startPage: 5,
      pageCount: 1, // mocked getWird returns one page
      nextPage: advanceStartPage(5, 1),
    });
  });

  it('re-shows the delivered wird and does NOT claim again', async () => {
    h.getDeliveryFor.mockResolvedValue({ startPage: 10, pageCount: 2 });
    const view = await buildTodayView(todaySub(), NOW);
    expect(view.alreadyDelivered).toBe(true);
    expect(view.claim).toBeNull();
    // Re-shows exactly the delivered pages (from the log), not currentPage.
    expect(h.getWird).toHaveBeenCalledWith(10, 2);
  });

  it('is a pure peek on an off day (no claim)', async () => {
    // activeDays = 2 is Tuesday only, so Monday (NOW) is off.
    const view = await buildTodayView(todaySub({ activeDays: 2 }), NOW);
    expect(view.messages.length).toBeGreaterThan(0);
    expect(view.claim).toBeNull();
    expect(view.alreadyDelivered).toBe(false);
  });

  it('is a pure peek while paused (no claim)', async () => {
    const view = await buildTodayView(todaySub({ pausedAt: new Date() }), NOW);
    expect(view.messages.length).toBeGreaterThan(0);
    expect(view.claim).toBeNull();
  });

  it('returns no messages (and no claim) when content cannot be built', async () => {
    h.getWird.mockResolvedValue([]);
    const view = await buildTodayView(todaySub(), NOW);
    expect(view.messages).toEqual([]);
    expect(view.claim).toBeNull();
  });
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

  it('on a partial multi-page wird, advances only by the pages actually sent', async () => {
    h.listDeliverableSubscribers.mockResolvedValue([sub({ wirdSize: 2 })]);
    h.getWird.mockResolvedValue(TWO_PAGES);
    h.sendMessages.mockResolvedValueOnce('ok').mockResolvedValueOnce('failed'); // page 2 fails
    const stats = await deliverDueSubscribers(fakeBot, NOW);
    expect(h.sendMessages).toHaveBeenCalledTimes(2);
    // Records one page and moves the position forward by one (page 1 -> 2), so
    // page 2 is retried next run with no duplicate of page 1.
    expect(h.commitDelivery).toHaveBeenCalledOnce();
    expect(h.commitDelivery.mock.calls[0][0]).toMatchObject({ pageCount: 1, nextPage: 2 });
    expect(stats).toMatchObject({ due: 1, sent: 1, failed: 0 });
  });

  it('marks a user blocked mid-wird but still commits the pages that went out', async () => {
    h.listDeliverableSubscribers.mockResolvedValue([sub({ wirdSize: 2 })]);
    h.getWird.mockResolvedValue(TWO_PAGES);
    h.sendMessages.mockResolvedValueOnce('ok').mockResolvedValueOnce('blocked'); // blocked on page 2
    const stats = await deliverDueSubscribers(fakeBot, NOW);
    expect(h.commitDelivery).toHaveBeenCalledOnce();
    expect(h.commitDelivery.mock.calls[0][0]).toMatchObject({ pageCount: 1, nextPage: 2 });
    expect(h.markBlocked).toHaveBeenCalledWith(1);
    expect(stats).toMatchObject({ due: 1, sent: 1 });
  });

  it('keeps going when one subscriber throws', async () => {
    h.listDeliverableSubscribers.mockResolvedValue([sub({ id: 1 }), sub({ id: 2 })]);
    h.getWird.mockRejectedValueOnce(new Error('boom')); // first subscriber fails
    const stats = await deliverDueSubscribers(fakeBot, NOW);
    expect(stats.failed).toBe(1);
    expect(stats.sent).toBe(1); // the second still delivered
  });
});
