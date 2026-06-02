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
}));
vi.mock('./database', () => ({
  ensureUser: vi.fn(),
  getChannelSubscriber: vi.fn(),
  getJuzForPage: h.getJuzForPage,
  setWirdSize: vi.fn(),
  setCurrentPage: h.setCurrentPage,
  toggleActiveDay: vi.fn(),
  setDeliveryTime: vi.fn(),
  setTimezone: vi.fn(),
  pauseSubscriber: vi.fn(),
  resumeSubscriber: vi.fn(),
  commitDelivery: h.commitDelivery,
}));
vi.mock('./lib/deliver', () => ({ buildTodayView: h.buildTodayView, previewWird: vi.fn() }));
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
});

describe('repositionToPage', () => {
  it('persists the new page once (does NOT recurse) and claims a free day', async () => {
    h.buildTodayView.mockResolvedValue({
      messages: ['the wird'],
      claim: { scheduledFor: '2026-06-01', startPage: 5, pageCount: 1, nextPage: 6 },
      alreadyDelivered: false,
    });
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
    // A confirmation plus the wird message were sent.
    expect(ctx.reply.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('does NOT claim when buildTodayView returns no claim (preview)', async () => {
    h.buildTodayView.mockResolvedValue({
      messages: ['the wird'],
      claim: null,
      alreadyDelivered: true,
    });
    const ctx = fakeCtx();
    await repositionToPage(ctx as never, SUB, 50);

    expect(h.setCurrentPage).toHaveBeenCalledWith(1, 50);
    expect(h.commitDelivery).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalled();
  });
});
