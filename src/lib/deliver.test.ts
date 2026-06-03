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
  getCachedPageImageIds: vi.fn(),
  cachePageImageId: vi.fn(),
  sendMessages: vi.fn(),
  sendPhoto: vi.fn(),
}));

vi.mock('../database', () => ({
  listDeliverableSubscribers: h.listDeliverableSubscribers,
  hasDeliveryFor: h.hasDeliveryFor,
  getDeliveryFor: h.getDeliveryFor,
  getWird: h.getWird,
  getBasmala: h.getBasmala,
  commitDelivery: h.commitDelivery,
  markBlocked: h.markBlocked,
  getCachedPageImageIds: h.getCachedPageImageIds,
  cachePageImageId: h.cachePageImageId,
  KIND_USER: 'user',
  KIND_CHANNEL: 'channel',
}));
vi.mock('./send', () => ({ sendMessages: h.sendMessages }));
vi.mock('./send-photo', () => ({ sendPhoto: h.sendPhoto }));
// A page-image source is configured by default so the image tests exercise the
// real photo path; the text tests don't reach it. The fallback test nulls it.
vi.mock('../config', () => ({
  config: { userWirdEnabled: true, mushafImageBaseUrl: 'https://x/{page3}.png' },
  channelEnabled: () => true,
}));
vi.mock('./logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { InputFile } from 'grammy';
import { deliverDueSubscribers, buildTodayView } from './deliver';
import { config } from '../config';
import { advanceStartPage } from '../core';

// The real config is frozen (readonly); the mock is a plain object we tweak per
// test, so reach it through a mutable view.
const mutableConfig = config as { mushafImageBaseUrl: string | null };

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
  // Restore the image source each run, in case a test nulled it.
  mutableConfig.mushafImageBaseUrl = 'https://x/{page3}.png';
  h.getBasmala.mockResolvedValue('بسم الله');
  h.getWird.mockResolvedValue(CONTENT);
  h.hasDeliveryFor.mockResolvedValue(false);
  h.getDeliveryFor.mockResolvedValue(null);
  h.commitDelivery.mockResolvedValue('sent');
  h.sendMessages.mockResolvedValue('ok');
  h.getCachedPageImageIds.mockResolvedValue(new Map());
  h.cachePageImageId.mockResolvedValue({});
  h.sendPhoto.mockResolvedValue({ result: 'ok', fileId: 'FILE_1' });
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
    expect(view.pages.length).toBeGreaterThan(0);
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
    expect(view.pages.length).toBeGreaterThan(0);
    expect(view.claim).toBeNull();
    expect(view.alreadyDelivered).toBe(false);
  });

  it('is a pure peek while paused (no claim)', async () => {
    const view = await buildTodayView(todaySub({ pausedAt: new Date() }), NOW);
    expect(view.pages.length).toBeGreaterThan(0);
    expect(view.claim).toBeNull();
  });

  it('returns no messages (and no claim) when content cannot be built', async () => {
    h.getWird.mockResolvedValue([]);
    const view = await buildTodayView(todaySub(), NOW);
    expect(view.pages).toEqual([]);
    expect(view.claim).toBeNull();
  });

  it('reposition shows the new page and claims when today is still free', async () => {
    const view = await buildTodayView(todaySub({ currentPage: 5 }), NOW, { reposition: true });
    expect(view.pages.length).toBeGreaterThan(0);
    expect(view.claim).toEqual({
      scheduledFor: '2026-06-01',
      startPage: 5,
      pageCount: 1,
      nextPage: advanceStartPage(5, 1),
    });
    expect(h.getWird).toHaveBeenCalledWith(5, 1);
  });

  it('reposition on an already-delivered day shows the NEW page (preview), no claim', async () => {
    h.getDeliveryFor.mockResolvedValue({ startPage: 10, pageCount: 2 });
    const view = await buildTodayView(todaySub({ currentPage: 5 }), NOW, { reposition: true });
    expect(view.claim).toBeNull();
    expect(view.pages.length).toBeGreaterThan(0);
    // Shows the just-set current page, NOT the earlier delivered pages.
    expect(h.getWird).toHaveBeenCalledWith(5, 1);
    expect(h.getWird).not.toHaveBeenCalledWith(10, 2);
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

describe('deliverDueSubscribers (image format)', () => {
  it('sends a photo (not text) from the source URL and caches the file_id', async () => {
    h.listDeliverableSubscribers.mockResolvedValue([sub({ wirdFormat: 'image', currentPage: 1 })]);
    const stats = await deliverDueSubscribers(fakeBot, NOW);

    expect(h.sendMessages).not.toHaveBeenCalled();
    expect(h.sendPhoto).toHaveBeenCalledOnce();
    // page 1 -> {page3} -> 001, with a caption
    const [, chatId, photo, caption] = h.sendPhoto.mock.calls[0];
    expect(chatId).toBe(123n);
    expect(photo).toBe('https://x/001.png');
    expect(typeof caption).toBe('string');
    // The returned file_id is cached for next time.
    expect(h.cachePageImageId).toHaveBeenCalledWith(1, 'FILE_1');
    expect(h.commitDelivery).toHaveBeenCalledOnce();
    expect(stats).toMatchObject({ due: 1, sent: 1, failed: 0 });
  });

  it('uploads a local file (InputFile) when the source is a filesystem path', async () => {
    mutableConfig.mushafImageBaseUrl = '/srv/mushaf/{page3}.jpg'; // a path, not a URL
    h.listDeliverableSubscribers.mockResolvedValue([sub({ wirdFormat: 'image', currentPage: 1 })]);
    await deliverDueSubscribers(fakeBot, NOW);
    const photoArg = h.sendPhoto.mock.calls[0][2];
    expect(photoArg).toBeInstanceOf(InputFile); // uploaded from disk, not a URL string
    expect(h.cachePageImageId).toHaveBeenCalledWith(1, 'FILE_1'); // file_id still cached
  });

  it('reuses a cached file_id and does not re-cache it', async () => {
    h.listDeliverableSubscribers.mockResolvedValue([sub({ wirdFormat: 'image', currentPage: 1 })]);
    h.getCachedPageImageIds.mockResolvedValue(new Map([[1, 'CACHED_1']]));
    h.sendPhoto.mockResolvedValue({ result: 'ok', fileId: 'CACHED_1' });

    await deliverDueSubscribers(fakeBot, NOW);

    expect(h.sendPhoto.mock.calls[0][2]).toBe('CACHED_1'); // sent by file_id, not URL
    expect(h.cachePageImageId).not.toHaveBeenCalled(); // unchanged, no re-cache
  });

  it('falls back to text when the photo send fails (never wedges on a bad page)', async () => {
    h.listDeliverableSubscribers.mockResolvedValue([sub({ wirdFormat: 'image', currentPage: 1 })]);
    h.sendPhoto.mockResolvedValue({ result: 'failed' }); // e.g. missing page / bad URL
    // The text fallback succeeds (sendMessages defaults to 'ok' in beforeEach).
    const stats = await deliverDueSubscribers(fakeBot, NOW);
    expect(h.sendPhoto).toHaveBeenCalledOnce();
    expect(h.sendMessages).toHaveBeenCalledOnce(); // delivered as text instead
    expect(h.commitDelivery).toHaveBeenCalledOnce();
    expect(stats).toMatchObject({ due: 1, sent: 1, failed: 0 });
  });

  it('does not advance when BOTH the photo and the text fallback fail (outage)', async () => {
    h.listDeliverableSubscribers.mockResolvedValue([sub({ wirdFormat: 'image', currentPage: 1 })]);
    h.sendPhoto.mockResolvedValue({ result: 'failed' });
    h.sendMessages.mockResolvedValue('failed');
    const stats = await deliverDueSubscribers(fakeBot, NOW);
    expect(h.commitDelivery).not.toHaveBeenCalled();
    expect(stats).toMatchObject({ due: 1, failed: 1, sent: 0 });
  });

  it('marks a user blocked on a 403 photo send and does NOT fall back to text', async () => {
    h.listDeliverableSubscribers.mockResolvedValue([
      sub({ id: 1, kind: 'user', wirdFormat: 'image', currentPage: 1 }),
    ]);
    h.sendPhoto.mockResolvedValue({ result: 'blocked' });
    const stats = await deliverDueSubscribers(fakeBot, NOW);
    expect(h.sendMessages).not.toHaveBeenCalled(); // a blocked chat blocks text too
    expect(h.markBlocked).toHaveBeenCalledWith(1);
    expect(h.commitDelivery).not.toHaveBeenCalled();
    expect(stats).toMatchObject({ due: 1, failed: 1, sent: 0 });
  });

  it('falls back to text when image is requested but no source is configured', async () => {
    mutableConfig.mushafImageBaseUrl = null; // restored in beforeEach
    h.listDeliverableSubscribers.mockResolvedValue([sub({ wirdFormat: 'image', currentPage: 1 })]);
    const stats = await deliverDueSubscribers(fakeBot, NOW);
    // The holy text still goes out, as text; no photo attempted.
    expect(h.sendPhoto).not.toHaveBeenCalled();
    expect(h.sendMessages).toHaveBeenCalledOnce();
    expect(h.commitDelivery).toHaveBeenCalledOnce();
    expect(stats).toMatchObject({ due: 1, sent: 1 });
  });

  it('sends one photo per page for a multi-page image wird (lead only on page 1)', async () => {
    h.listDeliverableSubscribers.mockResolvedValue([
      sub({ wirdFormat: 'image', wirdSize: 2, currentPage: 1 }),
    ]);
    h.getWird.mockResolvedValue(TWO_PAGES);
    h.sendPhoto
      .mockResolvedValueOnce({ result: 'ok', fileId: 'F1' })
      .mockResolvedValueOnce({ result: 'ok', fileId: 'F2' });

    const stats = await deliverDueSubscribers(fakeBot, NOW);

    expect(h.sendPhoto).toHaveBeenCalledTimes(2); // a photo per page
    expect(h.sendMessages).not.toHaveBeenCalled();
    // The lead line ("🌿 وردك اليوم") is on the first page's caption only.
    expect(h.sendPhoto.mock.calls[0][3]).toContain('🌿');
    expect(h.sendPhoto.mock.calls[1][3]).not.toContain('🌿');
    // Both pages cached, and the position advances by the full 2.
    expect(h.cachePageImageId).toHaveBeenCalledWith(1, 'F1');
    expect(h.cachePageImageId).toHaveBeenCalledWith(2, 'F2');
    expect(h.commitDelivery.mock.calls[0][0]).toMatchObject({
      pageCount: 2,
      nextPage: advanceStartPage(1, 2),
    });
    expect(stats).toMatchObject({ due: 1, sent: 1, failed: 0 });
  });

  it('on a multi-page image wird, one failed page falls back to text and the wird still completes', async () => {
    h.listDeliverableSubscribers.mockResolvedValue([
      sub({ wirdFormat: 'image', wirdSize: 2, currentPage: 1 }),
    ]);
    h.getWird.mockResolvedValue(TWO_PAGES);
    h.sendPhoto
      .mockResolvedValueOnce({ result: 'ok', fileId: 'F1' }) // page 1 as image
      .mockResolvedValueOnce({ result: 'failed' }); // page 2 image fails

    const stats = await deliverDueSubscribers(fakeBot, NOW);

    expect(h.sendPhoto).toHaveBeenCalledTimes(2); // tried image for both
    expect(h.sendMessages).toHaveBeenCalledOnce(); // page 2 fell back to text
    // The whole wird is recorded and the position advances by 2 (no page lost).
    expect(h.commitDelivery.mock.calls[0][0]).toMatchObject({
      pageCount: 2,
      nextPage: advanceStartPage(1, 2),
    });
    expect(stats).toMatchObject({ due: 1, sent: 1, failed: 0 });
  });
});
