import { describe, it, expect, beforeEach, vi } from 'vitest';

// Handler-level tests for the read-gated flow: /page (repositionToPage), the
// shared renderer (sendTodayView), the "read ✓" button (handleReadConfirm), and
// /next (advanceAndShowNext). All four are exported from bot.ts purely so they
// can be driven here with a fake ctx and mocked deps.
//
// bot.ts builds a grammY Bot and wires every command at import, so we mock the
// modules that would touch the network, the database, or env at load time.
const h = vi.hoisted(() => ({
  setCurrentPage: vi.fn(),
  getJuzForPage: vi.fn(),
  commitDelivery: vi.fn(),
  confirmRead: vi.fn(),
  getLatestUnconfirmedDelivery: vi.fn(),
  buildTodayView: vi.fn(),
  sendWird: vi.fn(),
  tajweedLessonView: vi.fn(),
  sendLesson: vi.fn(),
  sendPageAudio: vi.fn(),
  sendConfirmPrompt: vi.fn(),
  sendMissedDaysNudge: vi.fn(),
  sendWirdNow: vi.fn(),
  sendWirdAudioNow: vi.fn(),
  markStarted: vi.fn(),
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
  markStarted: h.markStarted,
  restartSubscriber: vi.fn(),
  toggleActiveDay: vi.fn(),
  setDeliveryTime: vi.fn(),
  setTimezone: vi.fn(),
  pauseSubscriber: vi.fn(),
  resumeSubscriber: vi.fn(),
  commitDelivery: h.commitDelivery,
  confirmRead: h.confirmRead,
  getLatestUnconfirmedDelivery: h.getLatestUnconfirmedDelivery,
  setTajweedEnabled: vi.fn(),
  setWirdAudioEnabled: vi.fn(),
  setReciter: vi.fn(),
  TAJWEED_LESSON_COUNT: 45,
  LESSONS_PENDING_REVIEW: false,
}));
vi.mock('./lib/deliver', () => ({
  buildTodayView: h.buildTodayView,
  sendWird: h.sendWird,
  tajweedLessonView: h.tajweedLessonView,
  sendLesson: h.sendLesson,
  sendPageAudio: h.sendPageAudio,
  sendConfirmPrompt: h.sendConfirmPrompt,
  sendMissedDaysNudge: h.sendMissedDaysNudge,
  sendWirdNow: h.sendWirdNow,
  sendWirdAudioNow: h.sendWirdAudioNow,
  sampleAudioPagesFor: vi.fn(),
  wirdPageNumbersFor: vi.fn(),
  buildLessonReview: vi.fn(),
  renderLessonAt: vi.fn(),
  previewWird: vi.fn(),
  READ_CONFIRM: 'tilawah:read',
  AUDIO_NOW: 'tilawah:listen',
}));
vi.mock('./scheduler', () => ({ runDeliveryOnce: vi.fn() }));
vi.mock('./lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { repositionToPage, sendTodayView, handleReadConfirm, advanceAndShowNext } from './bot';
import { advanceStartPage } from './core';

const SUB = {
  id: 1,
  chatId: 123n,
  // A reader who has already received a wird (the common case). A brand-new user
  // (startedAt null, no deliveries) is exercised explicitly where it matters.
  startedAt: new Date('2026-01-01T00:00:00Z'),
  pausedAt: null,
  currentPage: 1,
  wirdSize: 1,
  timezone: 'UTC',
  activeDays: 127,
  // Page recitation off by default so the wird-focused tests keep their exact
  // call counts; the recitation tests below pass a sub with it on.
  wirdAudioEnabled: false,
  reciter: 'abdulbasit',
} as never;

function fakeCtx() {
  return {
    reply: vi.fn().mockResolvedValue(undefined),
    answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
    editMessageReplyMarkup: vi.fn().mockResolvedValue(undefined),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.getJuzForPage.mockResolvedValue(5);
  h.commitDelivery.mockResolvedValue('sent');
  h.confirmRead.mockResolvedValue('advanced');
  h.getLatestUnconfirmedDelivery.mockResolvedValue({ startPage: 1, pageCount: 1 });
  // The whole wird went out (pagesSent matches the one page below), so a free
  // day is recorded.
  h.sendWird.mockResolvedValue({ pagesSent: 1, lastResult: 'ok' });
  h.sendWirdNow.mockResolvedValue(1);
  // Default: no tajweed lesson (these tests focus on the wird). Individual
  // tests override tajweedLessonView to exercise the lesson path.
  h.tajweedLessonView.mockResolvedValue(null);
  h.sendLesson.mockResolvedValue('ok');
});

// A one-page view that is RECORDABLE (today free). Read-gated: `record` has no
// nextPage — a user advances on a confirmed read, not on the show.
const ONE_PAGE_VIEW = (over: Record<string, unknown> = {}) => ({
  pages: [{ pageNumber: 5, juz: 1, ayat: [] }],
  basmala: 'بسم الله',
  lead: '🌿 وردك اليوم',
  record: { scheduledFor: '2026-06-01', startPage: 5, pageCount: 1 },
  alreadyDelivered: false,
  ...over,
});

describe('repositionToPage', () => {
  it('persists the new page once (does NOT recurse) and records a free day without advancing', async () => {
    h.buildTodayView.mockResolvedValue(ONE_PAGE_VIEW());
    const ctx = fakeCtx();
    await repositionToPage(ctx as never, SUB, 5);

    expect(h.setCurrentPage).toHaveBeenCalledTimes(1);
    expect(h.setCurrentPage).toHaveBeenCalledWith(1, 5);
    // The old recursion bug made this loop; the fix calls buildTodayView once.
    expect(h.buildTodayView).toHaveBeenCalledTimes(1);
    expect(h.buildTodayView).toHaveBeenCalledWith(
      expect.objectContaining({ currentPage: 5 }),
      expect.any(Date),
    );
    // Recorded as today's delivery, with NO position advance (no nextPage).
    expect(h.commitDelivery).toHaveBeenCalledTimes(1);
    expect(h.commitDelivery.mock.calls[0][0]).toMatchObject({ startPage: 5, pageCount: 1 });
    expect(h.commitDelivery.mock.calls[0][0].nextPage).toBeUndefined();
    expect(h.sendWird).toHaveBeenCalledTimes(1);
    expect(ctx.reply).toHaveBeenCalled();
  });

  it('does NOT record when the view is not recordable (already delivered / off / paused)', async () => {
    h.buildTodayView.mockResolvedValue(ONE_PAGE_VIEW({ record: null, alreadyDelivered: true }));
    const ctx = fakeCtx();
    await repositionToPage(ctx as never, SUB, 50);

    expect(h.setCurrentPage).toHaveBeenCalledWith(1, 50);
    expect(h.commitDelivery).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalled();
  });

  it('records exactly the pages that went out on a partial send (still no advance)', async () => {
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
      record: { scheduledFor: '2026-06-01', startPage: 5, pageCount: 3 },
    });
    await repositionToPage(fakeCtx() as never, SUB, 5);

    expect(h.commitDelivery).toHaveBeenCalledTimes(1);
    expect(h.commitDelivery.mock.calls[0][0]).toMatchObject({ startPage: 5, pageCount: 2 });
    expect(h.commitDelivery.mock.calls[0][0].nextPage).toBeUndefined();
  });

  it('does NOT record when nothing went out (pagesSent 0)', async () => {
    h.sendWird.mockResolvedValue({ pagesSent: 0, lastResult: 'failed' });
    h.buildTodayView.mockResolvedValue(ONE_PAGE_VIEW());
    await repositionToPage(fakeCtx() as never, SUB, 5);

    expect(h.commitDelivery).not.toHaveBeenCalled();
  });

  it('sends the tajweed lesson before the wird and advances it on a recorded day', async () => {
    h.tajweedLessonView.mockResolvedValue({
      index: 2,
      titleAr: 'الإقلاب',
      text: 'lesson text',
      example: { surah: 2, ayah: 27 },
    });
    h.buildTodayView.mockResolvedValue(ONE_PAGE_VIEW());
    await repositionToPage(fakeCtx() as never, SUB, 5);

    expect(h.sendLesson).toHaveBeenCalledOnce();
    // Lesson advanced from index 2 (TAJWEED_LESSON_COUNT 45 -> 3), a daily drip.
    expect(h.commitDelivery.mock.calls[0][0]).toMatchObject({ nextLessonIndex: 3 });
  });

  it('does not send the lesson when the view is not recordable', async () => {
    h.tajweedLessonView.mockResolvedValue({
      index: 2,
      titleAr: 'x',
      text: 't',
      example: { surah: 2, ayah: 27 },
    });
    h.buildTodayView.mockResolvedValue(ONE_PAGE_VIEW({ record: null, alreadyDelivered: true }));
    await repositionToPage(fakeCtx() as never, SUB, 50);

    expect(h.sendLesson).not.toHaveBeenCalled();
    expect(h.commitDelivery).not.toHaveBeenCalled();
  });

  it('does NOT send the missed-days nudge on a manual reposition (push-only), but still ends with the read-confirm prompt', async () => {
    h.buildTodayView.mockResolvedValue(ONE_PAGE_VIEW());
    await repositionToPage(fakeCtx() as never, SUB, 5);

    // The nudge leads the SCHEDULED daily push only; a manual /today or /page
    // (where the reader is already engaged) is never interrupted by it.
    expect(h.sendMissedDaysNudge).not.toHaveBeenCalled();
    expect(h.sendConfirmPrompt).toHaveBeenCalledTimes(1); // the "read ✓" button still rides the wird
  });
});

// The page recitation rides a fresh delivery on the /page (reposition) path, for
// exactly the pages that went out, in the subscriber's chosen reciter.
describe('sendTodayView page recitation', () => {
  const TWO_PAGE_VIEW = (over: Record<string, unknown> = {}) => ({
    pages: [
      { pageNumber: 5, juz: 1, ayat: [] },
      { pageNumber: 6, juz: 1, ayat: [] },
    ],
    basmala: 'بسم الله',
    lead: '🌿 وردك اليوم',
    record: { scheduledFor: '2026-06-01', startPage: 5, pageCount: 2 },
    alreadyDelivered: false,
    ...over,
  });

  it('recites the delivered pages in the chosen reciter when audio is on', async () => {
    h.sendWird.mockResolvedValue({ pagesSent: 2, lastResult: 'ok' });
    const audioSub = { ...(SUB as object), wirdAudioEnabled: true, reciter: 'husary' } as never;
    await sendTodayView(fakeCtx() as never, audioSub, TWO_PAGE_VIEW() as never, new Date());

    expect(h.sendPageAudio).toHaveBeenCalledTimes(1);
    const [, chatId, pages, reciter] = h.sendPageAudio.mock.calls[0];
    expect(chatId).toBe(123n);
    expect(pages.map((p: { pageNumber: number }) => p.pageNumber)).toEqual([5, 6]);
    expect(reciter).toBe('husary');
  });

  it('recites only the pages that actually went out on a partial send', async () => {
    h.sendWird.mockResolvedValue({ pagesSent: 1, lastResult: 'failed' });
    const audioSub = { ...(SUB as object), wirdAudioEnabled: true, reciter: 'husary' } as never;
    await sendTodayView(fakeCtx() as never, audioSub, TWO_PAGE_VIEW() as never, new Date());

    expect(h.sendPageAudio).toHaveBeenCalledTimes(1);
    expect(
      h.sendPageAudio.mock.calls[0][2].map((p: { pageNumber: number }) => p.pageNumber),
    ).toEqual([5]);
  });

  it('falls back to the default reciter for an unknown stored value', async () => {
    h.sendWird.mockResolvedValue({ pagesSent: 2, lastResult: 'ok' });
    const audioSub = { ...(SUB as object), wirdAudioEnabled: true, reciter: 'bogus' } as never;
    await sendTodayView(fakeCtx() as never, audioSub, TWO_PAGE_VIEW() as never, new Date());
    expect(h.sendPageAudio.mock.calls[0][3]).toBe('abdulbasit'); // normalizeReciter default
  });

  it('sends no recitation on a re-show (not recordable, so not a fresh delivery)', async () => {
    h.sendWird.mockResolvedValue({ pagesSent: 2, lastResult: 'ok' });
    const audioSub = { ...(SUB as object), wirdAudioEnabled: true, reciter: 'husary' } as never;
    const view = TWO_PAGE_VIEW({ record: null, alreadyDelivered: true });
    await sendTodayView(fakeCtx() as never, audioSub, view as never, new Date());
    expect(h.sendPageAudio).not.toHaveBeenCalled();
  });

  it('never sends the missed-days nudge (push-only; only the scheduler leads with it)', async () => {
    h.sendWird.mockResolvedValue({ pagesSent: 2, lastResult: 'ok' });
    await sendTodayView(fakeCtx() as never, SUB, TWO_PAGE_VIEW() as never, new Date());
    expect(h.sendMissedDaysNudge).not.toHaveBeenCalled();
  });

  it('sends no recitation when the commit loses the race (duplicate)', async () => {
    h.sendWird.mockResolvedValue({ pagesSent: 2, lastResult: 'ok' });
    h.commitDelivery.mockResolvedValue('duplicate');
    const audioSub = { ...(SUB as object), wirdAudioEnabled: true, reciter: 'husary' } as never;
    await sendTodayView(fakeCtx() as never, audioSub, TWO_PAGE_VIEW() as never, new Date());
    expect(h.sendPageAudio).not.toHaveBeenCalled();
  });

  it('does not show the confirm prompt while paused', async () => {
    h.sendWird.mockResolvedValue({ pagesSent: 2, lastResult: 'ok' });
    const pausedSub = { ...(SUB as object), pausedAt: new Date() } as never;
    await sendTodayView(fakeCtx() as never, pausedSub, TWO_PAGE_VIEW() as never, new Date());
    expect(h.sendConfirmPrompt).not.toHaveBeenCalled();
  });
});

// The "read ✓ / next" button: confirm this wird and reveal the next, idempotently.
describe('handleReadConfirm', () => {
  it('confirms THIS wird and reveals the next (delegates to the /next flow)', async () => {
    h.getLatestUnconfirmedDelivery.mockResolvedValue({ startPage: 10, pageCount: 2 });
    const ctx = fakeCtx();
    const sub = { ...(SUB as object), currentPage: 10 } as never;
    // The button carries the current wird's start page (10), so it is not stale.
    await handleReadConfirm(ctx as never, sub, 10);

    expect(ctx.editMessageReplyMarkup).toHaveBeenCalled(); // tapped button removed
    expect(h.confirmRead).toHaveBeenCalledWith(1, 10, advanceStartPage(10, 2), expect.any(Date));
    expect(h.sendWirdNow).toHaveBeenCalledTimes(1); // the next wird is revealed
  });

  it('is a gentle no-op on a STALE button (its page is no longer the current wird)', async () => {
    h.getLatestUnconfirmedDelivery.mockResolvedValue({ startPage: 10, pageCount: 2 });
    const ctx = fakeCtx();
    // current is page 10; the tapped button was for page 3 (a wird already passed).
    await handleReadConfirm(ctx as never, { ...(SUB as object), currentPage: 10 } as never, 3);

    expect(h.confirmRead).not.toHaveBeenCalled(); // nothing advanced
    expect(h.sendWirdNow).not.toHaveBeenCalled(); // nothing revealed
    expect(ctx.editMessageReplyMarkup).toHaveBeenCalled(); // stale button removed
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.any(String) }),
    );
  });

  it('advances even with NO unread delivery (a /next reveal button is not dead)', async () => {
    // After a /next reveal the wird has no unread delivery, but its button must
    // still advance — confirmRead's compare-and-set on currentPage is the guard,
    // not a pending delivery row. (Regression: the button used to silently no-op.)
    h.getLatestUnconfirmedDelivery.mockResolvedValue(null);
    const ctx = fakeCtx();
    const sub = { ...(SUB as object), currentPage: 10 } as never; // wirdSize 1
    await handleReadConfirm(ctx as never, sub, 10); // button pinned to the current wird

    expect(h.confirmRead).toHaveBeenCalledWith(1, 10, advanceStartPage(10, 1), expect.any(Date));
    expect(h.sendWirdNow).toHaveBeenCalledTimes(1); // the next wird is revealed
  });

  it('a legacy bare button (no page) acts on the current wird', async () => {
    h.getLatestUnconfirmedDelivery.mockResolvedValue({ startPage: 10, pageCount: 2 });
    const sub = { ...(SUB as object), currentPage: 10 } as never;
    await handleReadConfirm(fakeCtx() as never, sub); // no buttonStartPage (legacy)

    expect(h.confirmRead).toHaveBeenCalledWith(1, 10, advanceStartPage(10, 2), expect.any(Date));
    expect(h.sendWirdNow).toHaveBeenCalledTimes(1);
  });
});

// /next: advance one wird and show the next portion.
describe('advanceAndShowNext (/next)', () => {
  it('advances by the latest delivery’s pageCount, then reveals the next wird with its own button', async () => {
    h.getLatestUnconfirmedDelivery.mockResolvedValue({ startPage: 10, pageCount: 2 });
    const sub = { ...(SUB as object), currentPage: 10 } as never;
    await advanceAndShowNext(fakeCtx() as never, sub, new Date());

    expect(h.confirmRead).toHaveBeenCalledWith(1, 10, advanceStartPage(10, 2), expect.any(Date));
    expect(h.sendWirdNow).toHaveBeenCalledTimes(1);
    // The next wird is revealed from the advanced position, never skipping it.
    const nextPage = advanceStartPage(10, 2);
    expect(h.sendWirdNow.mock.calls[0][1]).toMatchObject({ currentPage: nextPage });
    // Its "read ✓" button carries the NEXT wird's start page (so the chain never
    // skips), plus the on-demand "listen" action (the reveal did not auto-send audio).
    expect(h.sendConfirmPrompt).toHaveBeenCalledWith(
      expect.anything(),
      123n,
      nextPage,
      expect.objectContaining({ audio: expect.any(Boolean) }),
    );
  });

  it('a brand-new reader (never delivered) sees their CURRENT wird, no advance, no skip', async () => {
    h.getLatestUnconfirmedDelivery.mockResolvedValue(null);
    const fresh = { ...(SUB as object), startedAt: null, currentPage: 1 } as never;
    await advanceAndShowNext(fakeCtx() as never, fresh, new Date());

    expect(h.markStarted).toHaveBeenCalledWith(1, expect.any(Date)); // stamp so next /next advances
    expect(h.confirmRead).not.toHaveBeenCalled(); // nothing to confirm yet
    // The current wird (page 1) is shown, not page 1 + size.
    expect(h.sendWirdNow.mock.calls[0][1]).toMatchObject({ currentPage: 1 });
  });

  it('falls back to the current wird size when there is no unread delivery', async () => {
    h.getLatestUnconfirmedDelivery.mockResolvedValue(null);
    const sub = { ...(SUB as object), currentPage: 10, wirdSize: 3 } as never;
    await advanceAndShowNext(fakeCtx() as never, sub, new Date());

    expect(h.confirmRead).toHaveBeenCalledWith(1, 10, advanceStartPage(10, 3), expect.any(Date));
    expect(h.sendWirdNow).toHaveBeenCalledTimes(1);
  });

  it('tells the reader when no wird could be prepared', async () => {
    h.getLatestUnconfirmedDelivery.mockResolvedValue(null);
    h.sendWirdNow.mockResolvedValue(0);
    const ctx = fakeCtx();
    await advanceAndShowNext(ctx as never, SUB, new Date());
    expect(ctx.reply).toHaveBeenCalled(); // COPY.notReady
  });
});
