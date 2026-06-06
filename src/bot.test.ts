import { describe, it, expect, beforeEach, vi } from 'vitest';

// Handler-level test for the /page reposition helper. This guards the bug a
// copy-paste once introduced (repositionToPage calling itself -> infinite
// recursion): typecheck and the buildTodayView unit tests both stayed green,
// so only a test that actually RUNS the handler catches it.
//
// bot.ts builds a grammY Bot and wires every command at import, so we mock the
// modules that would touch the network, the database, or env at load time.
const h = vi.hoisted(() => ({
  setCurrentPage: vi.fn(),
  getJuzForPage: vi.fn(),
  commitDelivery: vi.fn(),
  buildTodayView: vi.fn(),
  sendWird: vi.fn(),
}));

vi.mock('./config', () => ({
  config: {
    botToken: 'test-token',
    defaultTimezone: 'UTC',
    userWirdEnabled: true,
    adminIds: new Set(),
    channelChatIdRaw: null,
    isDev: true,
  },
  channelEnabled: () => false,
  imageWirdAvailable: () => false,
}));
vi.mock('./database', () => ({
  ensureUser: vi.fn(),
  getChannelSubscriber: vi.fn(),
  getJuzForPage: h.getJuzForPage,
  setWirdSize: vi.fn(),
  setWirdFormat: vi.fn(),
  setCurrentPage: h.setCurrentPage,
  toggleActiveDay: vi.fn(),
  setDeliveryTime: vi.fn(),
  setTimezone: vi.fn(),
  pauseSubscriber: vi.fn(),
  resumeSubscriber: vi.fn(),
  commitDelivery: h.commitDelivery,
}));
vi.mock('./lib/deliver', () => ({
  buildTodayView: h.buildTodayView,
  sendWird: h.sendWird,
  previewWird: vi.fn(),
}));
vi.mock('./scheduler', () => ({ runDeliveryOnce: vi.fn() }));
vi.mock('./lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { repositionToPage } from './bot';

const SUB = {
  id: 1,
  startedAt: null,
  pausedAt: null,
  currentPage: 1,
  wirdSize: 1,
  timezone: 'UTC',
  activeDays: 127,
} as never;

function fakeCtx() {
  return { reply: vi.fn().mockResolvedValue(undefined) };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.getJuzForPage.mockResolvedValue(5);
  h.commitDelivery.mockResolvedValue('sent');
  // The whole wird went out (pagesSent matches the one page below), so /today
  // and reposition claim the day.
  h.sendWird.mockResolvedValue({ pagesSent: 1, lastResult: 'ok' });
});

// A one-page view; pagesSent (1) matching pages.length (1) means a free day is
// claimed. basmala/lead are passed through to the (mocked) renderer.
const ONE_PAGE_VIEW = (over: Record<string, unknown> = {}) => ({
  pages: [{ pageNumber: 5, juz: 1, ayat: [] }],
  basmala: 'بسم الله',
  lead: '🌿 وردك اليوم',
  claim: null,
  alreadyDelivered: false,
  ...over,
});

describe('repositionToPage', () => {
  it('persists the new page once (does NOT recurse) and claims a free day', async () => {
    h.buildTodayView.mockResolvedValue(
      ONE_PAGE_VIEW({
        claim: { scheduledFor: '2026-06-01', startPage: 5, pageCount: 1, nextPage: 6 },
      }),
    );
    const ctx = fakeCtx();
    await repositionToPage(ctx as never, SUB, 5);

    expect(h.setCurrentPage).toHaveBeenCalledTimes(1);
    expect(h.setCurrentPage).toHaveBeenCalledWith(1, 5);
    // The bug made this recurse; the fix calls buildTodayView exactly once.
    expect(h.buildTodayView).toHaveBeenCalledTimes(1);
    expect(h.buildTodayView).toHaveBeenCalledWith(
      expect.objectContaining({ currentPage: 5 }),
      expect.any(Date),
      { reposition: true },
    );
    expect(h.commitDelivery).toHaveBeenCalledTimes(1); // claimed
    // The wird itself went out via sendWird; a confirmation went via reply.
    expect(h.sendWird).toHaveBeenCalledTimes(1);
    expect(ctx.reply).toHaveBeenCalled();
  });

  it('does NOT claim when buildTodayView returns no claim (preview)', async () => {
    h.buildTodayView.mockResolvedValue(ONE_PAGE_VIEW({ claim: null, alreadyDelivered: true }));
    const ctx = fakeCtx();
    await repositionToPage(ctx as never, SUB, 50);

    expect(h.setCurrentPage).toHaveBeenCalledWith(1, 50);
    expect(h.commitDelivery).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalled();
  });

  it('on a PARTIAL send, claims exactly the pages that went out (mirrors the scheduler)', async () => {
    // 3-page wird, but the send dies after 2 pages. The day must be recorded as
    // 2 pages advancing to page 7 — NOT the claim's full 3 pages / page 8 — so
    // the scheduler later sends only the remaining page instead of re-sending
    // the 2 the user already received.
    h.sendWird.mockResolvedValue({ pagesSent: 2, lastResult: 'failed' });
    h.buildTodayView.mockResolvedValue({
      pages: [
        { pageNumber: 5, juz: 1, ayat: [] },
        { pageNumber: 6, juz: 1, ayat: [] },
        { pageNumber: 7, juz: 1, ayat: [] },
      ],
      basmala: 'بسم الله',
      lead: '🌿 وردك اليوم',
      alreadyDelivered: false,
      claim: { scheduledFor: '2026-06-01', startPage: 5, pageCount: 3, nextPage: 8 },
    });
    await repositionToPage(fakeCtx() as never, SUB, 5);

    expect(h.commitDelivery).toHaveBeenCalledTimes(1);
    expect(h.commitDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ startPage: 5, pageCount: 2, nextPage: 7 }),
    );
  });

  it('does NOT claim when nothing went out (pagesSent 0)', async () => {
    h.sendWird.mockResolvedValue({ pagesSent: 0, lastResult: 'failed' });
    h.buildTodayView.mockResolvedValue(
      ONE_PAGE_VIEW({
        claim: { scheduledFor: '2026-06-01', startPage: 5, pageCount: 1, nextPage: 6 },
      }),
    );
    await repositionToPage(fakeCtx() as never, SUB, 5);

    expect(h.commitDelivery).not.toHaveBeenCalled();
  });
});
