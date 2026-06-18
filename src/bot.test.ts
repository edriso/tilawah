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
  growDelivery: vi.fn(),
  buildTodayView: vi.fn(),
  sendWird: vi.fn(),
  tajweedLessonView: vi.fn(),
  sendLesson: vi.fn(),
  sendPageAudio: vi.fn(),
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
  restartSubscriber: vi.fn(),
  toggleActiveDay: vi.fn(),
  setDeliveryTime: vi.fn(),
  setTimezone: vi.fn(),
  pauseSubscriber: vi.fn(),
  resumeSubscriber: vi.fn(),
  commitDelivery: h.commitDelivery,
  growDelivery: h.growDelivery,
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
  deliveredCountToday: vi.fn(),
  buildLessonReview: vi.fn(),
  previewWird: vi.fn(),
}));
vi.mock('./scheduler', () => ({ runDeliveryOnce: vi.fn() }));
vi.mock('./lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { repositionToPage, sendTodayView } from './bot';
import { advanceStartPage } from './core';

const SUB = {
  id: 1,
  chatId: 123n,
  startedAt: null,
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
  return { reply: vi.fn().mockResolvedValue(undefined) };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.getJuzForPage.mockResolvedValue(5);
  h.commitDelivery.mockResolvedValue('sent');
  h.growDelivery.mockResolvedValue(undefined);
  // The whole wird went out (pagesSent matches the one page below), so /today
  // and reposition claim the day.
  h.sendWird.mockResolvedValue({ pagesSent: 1, lastResult: 'ok' });
  // Default: no tajweed lesson (these tests focus on the wird). Individual
  // tests override tajweedLessonView to exercise the lesson path.
  h.tajweedLessonView.mockResolvedValue(null);
  h.sendLesson.mockResolvedValue('ok');
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

  it('sends the tajweed lesson before the wird and advances it on a claim', async () => {
    h.tajweedLessonView.mockResolvedValue({
      index: 2,
      titleAr: 'الإقلاب',
      text: 'lesson text',
      example: { surah: 2, ayah: 27 },
    });
    h.buildTodayView.mockResolvedValue(
      ONE_PAGE_VIEW({
        claim: { scheduledFor: '2026-06-01', startPage: 5, pageCount: 1, nextPage: 6 },
      }),
    );
    await repositionToPage(fakeCtx() as never, SUB, 5);

    expect(h.sendLesson).toHaveBeenCalledOnce();
    // Committed with the lesson advanced from index 2 (TAJWEED_LESSON_COUNT 45 -> 3).
    expect(h.commitDelivery.mock.calls[0][0]).toMatchObject({ nextLessonIndex: 3 });
  });

  it('does not advance the lesson on a preview (no claim)', async () => {
    h.tajweedLessonView.mockResolvedValue({
      index: 2,
      titleAr: 'x',
      text: 't',
      example: { surah: 2, ayah: 27 },
    });
    h.buildTodayView.mockResolvedValue(ONE_PAGE_VIEW({ claim: null, alreadyDelivered: true }));
    await repositionToPage(fakeCtx() as never, SUB, 50);

    expect(h.sendLesson).not.toHaveBeenCalled();
    expect(h.commitDelivery).not.toHaveBeenCalled();
  });
});

// The page recitation must follow the wird on the /page (reposition) and /today
// path too, not only the scheduler — and for exactly the pages that went out, in
// the subscriber's chosen reciter. These guard that wiring in sendTodayView.
describe('repositionToPage page recitation', () => {
  // A two-page view (pages 5 and 6) so the slice-to-pagesSent can be asserted.
  const TWO_PAGE_VIEW = (over: Record<string, unknown> = {}) => ({
    pages: [
      { pageNumber: 5, juz: 1, ayat: [] },
      { pageNumber: 6, juz: 1, ayat: [] },
    ],
    basmala: 'بسم الله',
    lead: '🌿 وردك اليوم',
    claim: { scheduledFor: '2026-06-01', startPage: 5, pageCount: 2, nextPage: 7 },
    alreadyDelivered: false,
    ...over,
  });

  it('recites the delivered pages in the chosen reciter when audio is on', async () => {
    h.sendWird.mockResolvedValue({ pagesSent: 2, lastResult: 'ok' });
    h.buildTodayView.mockResolvedValue(TWO_PAGE_VIEW());
    const audioSub = { ...(SUB as object), wirdAudioEnabled: true, reciter: 'husary' } as never;
    await repositionToPage(fakeCtx() as never, audioSub, 5);

    expect(h.sendPageAudio).toHaveBeenCalledTimes(1);
    const [, chatId, pages, reciter] = h.sendPageAudio.mock.calls[0];
    expect(chatId).toBe(123n);
    expect(pages.map((p: { pageNumber: number }) => p.pageNumber)).toEqual([5, 6]);
    expect(reciter).toBe('husary');
  });

  it('recites only the pages that actually went out on a partial send', async () => {
    // 2-page wird, but the send dies after page 5. The recitation must follow
    // exactly the delivered page, never the unsent one.
    h.sendWird.mockResolvedValue({ pagesSent: 1, lastResult: 'failed' });
    h.buildTodayView.mockResolvedValue(TWO_PAGE_VIEW());
    const audioSub = { ...(SUB as object), wirdAudioEnabled: true, reciter: 'husary' } as never;
    await repositionToPage(fakeCtx() as never, audioSub, 5);

    expect(h.sendPageAudio).toHaveBeenCalledTimes(1);
    expect(
      h.sendPageAudio.mock.calls[0][2].map((p: { pageNumber: number }) => p.pageNumber),
    ).toEqual([5]);
  });

  it('falls back to the default reciter for an unknown stored value', async () => {
    h.sendWird.mockResolvedValue({ pagesSent: 2, lastResult: 'ok' });
    h.buildTodayView.mockResolvedValue(TWO_PAGE_VIEW());
    const audioSub = { ...(SUB as object), wirdAudioEnabled: true, reciter: 'bogus' } as never;
    await repositionToPage(fakeCtx() as never, audioSub, 5);

    expect(h.sendPageAudio.mock.calls[0][3]).toBe('abdulbasit'); // normalizeReciter default
  });

  it('sends no recitation when the user turned audio off', async () => {
    h.sendWird.mockResolvedValue({ pagesSent: 2, lastResult: 'ok' });
    h.buildTodayView.mockResolvedValue(TWO_PAGE_VIEW());
    const audioSub = { ...(SUB as object), wirdAudioEnabled: false } as never;
    await repositionToPage(fakeCtx() as never, audioSub, 5);

    expect(h.sendPageAudio).not.toHaveBeenCalled();
  });

  it('sends no recitation when nothing went out (pagesSent 0)', async () => {
    h.sendWird.mockResolvedValue({ pagesSent: 0, lastResult: 'failed' });
    h.buildTodayView.mockResolvedValue(TWO_PAGE_VIEW());
    const audioSub = { ...(SUB as object), wirdAudioEnabled: true, reciter: 'husary' } as never;
    await repositionToPage(fakeCtx() as never, audioSub, 5);

    expect(h.sendPageAudio).not.toHaveBeenCalled();
  });

  it('sends no recitation on a re-show / preview (no claim)', async () => {
    // The wird is shown again, but the recitation is tied to a real delivery, so
    // it does NOT re-send on a preview — matching the ayah bot.
    h.sendWird.mockResolvedValue({ pagesSent: 2, lastResult: 'ok' });
    h.buildTodayView.mockResolvedValue(TWO_PAGE_VIEW({ claim: null, alreadyDelivered: true }));
    const audioSub = { ...(SUB as object), wirdAudioEnabled: true, reciter: 'husary' } as never;
    await repositionToPage(fakeCtx() as never, audioSub, 5);

    expect(h.sendPageAudio).not.toHaveBeenCalled();
  });

  it('sends no recitation when the commit loses the race (duplicate)', async () => {
    // The scheduler delivered the same day first: commitDelivery reports
    // 'duplicate' and the page did not advance here, so the audio does not fire.
    h.sendWird.mockResolvedValue({ pagesSent: 2, lastResult: 'ok' });
    h.commitDelivery.mockResolvedValue('duplicate');
    h.buildTodayView.mockResolvedValue(TWO_PAGE_VIEW());
    const audioSub = { ...(SUB as object), wirdAudioEnabled: true, reciter: 'husary' } as never;
    await repositionToPage(fakeCtx() as never, audioSub, 5);

    expect(h.sendPageAudio).not.toHaveBeenCalled();
  });
});

// sendTodayView GROWS today's record (instead of creating one) when the view is
// a top-up: the reader raised their wird size on a day already delivered, so the
// remaining pages go out now and the position advances by exactly what was sent.
describe('sendTodayView top-up', () => {
  // A two-page top-up view: the rest of today (pages 11, 12) at the new size,
  // sent from the already-advanced position (startPage 11).
  const TOP_UP_VIEW = (over: Record<string, unknown> = {}) => ({
    pages: [
      { pageNumber: 11, juz: 1, ayat: [] },
      { pageNumber: 12, juz: 1, ayat: [] },
    ],
    basmala: 'بسم الله',
    lead: '🌿 وردك اليوم',
    claim: null,
    topUp: { scheduledFor: '2026-06-01', startPage: 11 },
    alreadyDelivered: true,
    ...over,
  });

  it('grows the day and advances by the pages sent, never creating a new delivery', async () => {
    h.sendWird.mockResolvedValue({ pagesSent: 2, lastResult: 'ok' });
    await sendTodayView(fakeCtx() as never, SUB, TOP_UP_VIEW() as never, new Date('2026-06-01'));

    expect(h.growDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        subscriberId: 1,
        scheduledFor: '2026-06-01',
        addPages: 2,
        nextPage: advanceStartPage(11, 2),
      }),
    );
    expect(h.commitDelivery).not.toHaveBeenCalled(); // a top-up never creates a row
  });

  it('grows by ONLY the pages that went out on a partial top-up', async () => {
    h.sendWird.mockResolvedValue({ pagesSent: 1, lastResult: 'failed' }); // page 12 fails
    await sendTodayView(fakeCtx() as never, SUB, TOP_UP_VIEW() as never, new Date('2026-06-01'));

    expect(h.growDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ addPages: 1, nextPage: advanceStartPage(11, 1) }),
    );
  });

  it('does NOT grow when nothing went out (pagesSent 0)', async () => {
    h.sendWird.mockResolvedValue({ pagesSent: 0, lastResult: 'failed' });
    await sendTodayView(fakeCtx() as never, SUB, TOP_UP_VIEW() as never, new Date('2026-06-01'));

    expect(h.growDelivery).not.toHaveBeenCalled();
  });

  it('never re-sends the daily tajweed lesson on a top-up (it went out earlier today)', async () => {
    h.tajweedLessonView.mockResolvedValue({
      index: 2,
      titleAr: 'الإقلاب',
      text: 'lesson',
      example: { surah: 2, ayah: 27 },
    });
    h.sendWird.mockResolvedValue({ pagesSent: 2, lastResult: 'ok' });
    await sendTodayView(fakeCtx() as never, SUB, TOP_UP_VIEW() as never, new Date('2026-06-01'));

    expect(h.sendLesson).not.toHaveBeenCalled();
  });

  it('recites the topped-up pages when audio is on', async () => {
    h.sendWird.mockResolvedValue({ pagesSent: 2, lastResult: 'ok' });
    const audioSub = { ...(SUB as object), wirdAudioEnabled: true, reciter: 'husary' } as never;
    await sendTodayView(
      fakeCtx() as never,
      audioSub,
      TOP_UP_VIEW() as never,
      new Date('2026-06-01'),
    );

    expect(h.sendPageAudio).toHaveBeenCalledTimes(1);
    const [, , pages, reciter] = h.sendPageAudio.mock.calls[0];
    expect(pages.map((p: { pageNumber: number }) => p.pageNumber)).toEqual([11, 12]);
    expect(reciter).toBe('husary');
  });

  it('sends no recitation when the top-up sent nothing', async () => {
    h.sendWird.mockResolvedValue({ pagesSent: 0, lastResult: 'failed' });
    const audioSub = { ...(SUB as object), wirdAudioEnabled: true, reciter: 'husary' } as never;
    await sendTodayView(
      fakeCtx() as never,
      audioSub,
      TOP_UP_VIEW() as never,
      new Date('2026-06-01'),
    );

    expect(h.sendPageAudio).not.toHaveBeenCalled();
  });
});
