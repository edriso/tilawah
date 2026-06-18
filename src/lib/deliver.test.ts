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
  countUnreadDeliveriesBefore: vi.fn(),
  markBlocked: vi.fn(),
  getCachedPageImageIds: vi.fn(),
  cachePageImageId: vi.fn(),
  sendMessages: vi.fn(),
  sendPhoto: vi.fn(),
  sendPhotoAlbum: vi.fn(),
  sendAudio: vi.fn(),
  getAyahText: vi.fn(),
  getCachedTajweedAudioId: vi.fn(),
  cacheTajweedAudioId: vi.fn(),
  getCachedPageAudioId: vi.fn(),
  cachePageAudioId: vi.fn(),
  // A tiny fake lesson deck (3 lessons) so the cycle/advance can be asserted.
  // Defined inside hoisted state so the vi.mock factory below can reference it.
  lessons: [
    { titleAr: 'الإقلاب', bodyAr: 'قاعدة الإقلاب.', example: { surah: 2, ayah: 27 } },
    { titleAr: 'الإظهار', bodyAr: 'قاعدة الإظهار.', example: { surah: 1, ayah: 7 } },
    { titleAr: 'المد', bodyAr: 'قاعدة المد.', example: { surah: 1, ayah: 2 } },
  ],
}));

vi.mock('../database', () => ({
  listDeliverableSubscribers: h.listDeliverableSubscribers,
  hasDeliveryFor: h.hasDeliveryFor,
  getDeliveryFor: h.getDeliveryFor,
  getWird: h.getWird,
  getBasmala: h.getBasmala,
  getAyahText: h.getAyahText,
  commitDelivery: h.commitDelivery,
  countUnreadDeliveriesBefore: h.countUnreadDeliveriesBefore,
  markBlocked: h.markBlocked,
  getCachedPageImageIds: h.getCachedPageImageIds,
  cachePageImageId: h.cachePageImageId,
  getCachedTajweedAudioId: h.getCachedTajweedAudioId,
  cacheTajweedAudioId: h.cacheTajweedAudioId,
  getCachedPageAudioId: h.getCachedPageAudioId,
  cachePageAudioId: h.cachePageAudioId,
  // A fixed encouragement reference; getAyahText (mocked) resolves its text.
  pickQuranVirtue: () => ({ surah: 2, ayah: 27 }),
  TAJWEED_LESSONS: h.lessons,
  TAJWEED_LESSON_COUNT: h.lessons.length,
  // These tests exercise the LIVE behaviour (deck reviewed). The pending-review
  // gate is a plain boolean short-circuit in tajweedLessonView.
  LESSONS_PENDING_REVIEW: false,
  KIND_USER: 'user',
  KIND_CHANNEL: 'channel',
}));
vi.mock('./send', () => ({ sendMessages: h.sendMessages }));
vi.mock('./send-photo', () => ({
  sendPhoto: h.sendPhoto,
  sendPhotoAlbum: h.sendPhotoAlbum,
  MAX_ALBUM_SIZE: 10,
}));
vi.mock('./send-audio', () => ({ sendAudio: h.sendAudio }));
// A page-image source is configured by default so the image tests exercise the
// real photo path; the text tests don't reach it. The fallback test nulls it.
// Tajweed audio is off by default (lessons go out as text); one test enables it.
vi.mock('../config', () => ({
  config: {
    userWirdEnabled: true,
    mushafImageBaseUrl: 'https://x/{page3}.png',
    tajweedAudioBaseUrl: null,
  },
  channelEnabled: () => true,
}));
vi.mock('./logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { InputFile } from 'grammy';
import {
  deliverDueSubscribers,
  buildTodayView,
  buildLessonReview,
  renderLessonAt,
  sampleAudioPagesFor,
  wirdPageNumbersFor,
} from './deliver';
import { config } from '../config';
import { advanceStartPage } from '../core';

// The real config is frozen (readonly); the mock is a plain object we tweak per
// test, so reach it through a mutable view.
const mutableConfig = config as {
  mushafImageBaseUrl: string | null;
  tajweedAudioBaseUrl: string | null;
};

const NOW = new Date('2026-06-01T12:00:00Z');
// The read-confirm prompt is sent via bot.api.sendMessage (not the mocked
// send wrapper), so the fake bot needs an api stub we can assert on.
const apiSendMessage = vi.fn().mockResolvedValue({});
const fakeBot = { api: { sendMessage: apiSendMessage } } as never;
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

// N consecutive pages (1..N), for the multi-album (>10 pages) cases.
const manyPages = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    pageNumber: i + 1,
    juz: 1,
    ayat: [{ surahNumber: 2, surahNameAr: 'البقرة', numberInSurah: i + 1, text: 'نص' }],
  }));

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
    // Tajweed lesson + page audio off by default here so the wird-focused tests
    // keep their exact send counts; the relevant tests turn them on explicitly.
    tajweedEnabled: false,
    tajweedLessonIndex: 0,
    wirdAudioEnabled: false,
    reciter: 'abdulbasit',
    pausedAt: null,
    blockedAt: null,
    startedAt: null,
    ...over,
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  // Restore the sources each run, in case a test changed them.
  mutableConfig.mushafImageBaseUrl = 'https://x/{page3}.png';
  mutableConfig.tajweedAudioBaseUrl = null;
  h.getAyahText.mockResolvedValue({ surahNameAr: 'البقرة', numberInSurah: 27, text: 'نص الآية' });
  h.getCachedTajweedAudioId.mockResolvedValue(null);
  h.cacheTajweedAudioId.mockResolvedValue({});
  h.getCachedPageAudioId.mockResolvedValue(null);
  h.cachePageAudioId.mockResolvedValue({});
  h.sendAudio.mockResolvedValue({ result: 'ok', fileId: 'AUDIO_1' });
  h.getBasmala.mockResolvedValue('بسم الله');
  h.getWird.mockResolvedValue(CONTENT);
  h.hasDeliveryFor.mockResolvedValue(false);
  h.getDeliveryFor.mockResolvedValue(null);
  h.countUnreadDeliveriesBefore.mockResolvedValue(0); // not behind by default
  h.commitDelivery.mockResolvedValue('sent');
  apiSendMessage.mockClear();
  h.sendMessages.mockResolvedValue('ok');
  h.getCachedPageImageIds.mockResolvedValue(new Map());
  h.cachePageImageId.mockResolvedValue({});
  h.sendPhoto.mockResolvedValue({ result: 'ok', fileId: 'FILE_1' });
  // Album succeeds by default, returning a file_id per item (FA1, FA2, ...).
  h.sendPhotoAlbum.mockImplementation(async (_bot, _chatId, items: { caption?: string }[]) => ({
    result: 'ok',
    fileIds: items.map((_, i) => `FA${i + 1}`),
  }));
});

// NOW (2026-06-01, UTC) is a Monday, ISO weekday 1.
describe('buildTodayView (read-gated: shows the live wird, never advances)', () => {
  const todaySub = (over: Record<string, unknown> = {}) => ({
    id: 1,
    timezone: 'UTC',
    activeDays: 127,
    pausedAt: null,
    currentPage: 5,
    wirdSize: 1,
    ...over,
  });

  it('records today on an active, unpaused, not-yet-delivered day (NO advance)', async () => {
    const view = await buildTodayView(todaySub(), NOW);
    expect(view.alreadyDelivered).toBe(false);
    expect(view.pages.length).toBeGreaterThan(0);
    // The record has no nextPage: a user advances only on a confirmed read.
    expect(view.record).toEqual({
      scheduledFor: '2026-06-01',
      startPage: 5,
      pageCount: 1, // mocked getWird returns one page
    });
    expect(view.record).not.toHaveProperty('nextPage');
  });

  it('re-shows the LIVE wird at the current page and does NOT record again', async () => {
    h.getDeliveryFor.mockResolvedValue({ startPage: 5, pageCount: 1 });
    const view = await buildTodayView(todaySub(), NOW);
    expect(view.alreadyDelivered).toBe(true);
    expect(view.record).toBeNull();
    // The position never moved, so the live wird IS the unread one (current page).
    expect(h.getWird).toHaveBeenCalledWith(5, 1);
  });

  it('reflects a raised wird size at once, even after today was delivered', async () => {
    // The original bug: raise the size, /today still showed the small wird.
    // Read-gated fixes it for free — the wird is always live at the current page.
    h.getDeliveryFor.mockResolvedValue({ startPage: 5, pageCount: 1 });
    h.getWird.mockResolvedValue(manyPages(5));
    const view = await buildTodayView(todaySub({ wirdSize: 5 }), NOW);
    expect(view.record).toBeNull(); // already delivered, so not re-recorded
    expect(h.getWird).toHaveBeenCalledWith(5, 5); // the bigger, live wird
    expect(view.pages).toHaveLength(5);
  });

  it('is a pure peek on an off day (no record)', async () => {
    // activeDays = 2 is Tuesday only, so Monday (NOW) is off.
    const view = await buildTodayView(todaySub({ activeDays: 2 }), NOW);
    expect(view.pages.length).toBeGreaterThan(0);
    expect(view.record).toBeNull();
    expect(view.alreadyDelivered).toBe(false);
  });

  it('is a pure peek while paused (no record)', async () => {
    const view = await buildTodayView(todaySub({ pausedAt: new Date() }), NOW);
    expect(view.pages.length).toBeGreaterThan(0);
    expect(view.record).toBeNull();
  });

  it('returns no messages (and no record) when content cannot be built', async () => {
    h.getWird.mockResolvedValue([]);
    const view = await buildTodayView(todaySub(), NOW);
    expect(view.pages).toEqual([]);
    expect(view.record).toBeNull();
  });
});

describe('sampleAudioPagesFor (the reciter "try it on today\'s page" preview)', () => {
  beforeEach(() => {
    h.getDeliveryFor.mockResolvedValue(null);
    h.getWird.mockResolvedValue(CONTENT);
  });

  it("samples today's first DELIVERED page (one page) when there is a delivery", async () => {
    h.getDeliveryFor.mockResolvedValue({ startPage: 10, pageCount: 3 });
    const pages = await sampleAudioPagesFor({ id: 1, timezone: 'UTC', currentPage: 5 }, NOW);
    expect(h.getWird).toHaveBeenCalledWith(10, 1); // delivered start, ONE page
    expect(pages).toEqual(CONTENT);
  });

  it('samples the current page (one page) when today is not delivered', async () => {
    const pages = await sampleAudioPagesFor({ id: 1, timezone: 'UTC', currentPage: 5 }, NOW);
    expect(h.getWird).toHaveBeenCalledWith(5, 1);
    expect(pages).toEqual(CONTENT);
  });

  it('returns [] when no page resolves', async () => {
    h.getWird.mockResolvedValue([]);
    expect(await sampleAudioPagesFor({ id: 1, timezone: 'UTC', currentPage: 1 }, NOW)).toEqual([]);
  });
});

describe('wirdPageNumbersFor (the /tafsir page links)', () => {
  beforeEach(() => {
    h.getDeliveryFor.mockResolvedValue(null);
    h.getWird.mockResolvedValue(TWO_PAGES); // pages 1 and 2
  });

  it("uses today's DELIVERED range when there is a delivery", async () => {
    h.getDeliveryFor.mockResolvedValue({ startPage: 10, pageCount: 2 });
    const pages = await wirdPageNumbersFor(
      { id: 1, timezone: 'UTC', currentPage: 5, wirdSize: 2 },
      NOW,
    );
    expect(h.getWird).toHaveBeenCalledWith(10, 2); // delivered start + count
    expect(pages).toEqual([1, 2]); // the page numbers getWird returned
  });

  it("ignores a wird-size / page change made AFTER today's delivery (uses the delivered range)", async () => {
    // Delivered 1 page from page 10 this morning; the reader has since done
    // /wird 10 and /page 50. /tafsir must still cover what they got TODAY (the
    // delivered page), not the new, not-yet-delivered wird.
    h.getDeliveryFor.mockResolvedValue({ startPage: 10, pageCount: 1 });
    h.getWird.mockResolvedValue(CONTENT); // one page
    await wirdPageNumbersFor({ id: 1, timezone: 'UTC', currentPage: 50, wirdSize: 10 }, NOW);
    expect(h.getWird).toHaveBeenCalledWith(10, 1); // delivered range, NOT 50 / 10
  });

  it('uses the current position + current wird size when not delivered', async () => {
    const pages = await wirdPageNumbersFor(
      { id: 1, timezone: 'UTC', currentPage: 5, wirdSize: 2 },
      NOW,
    );
    expect(h.getWird).toHaveBeenCalledWith(5, 2);
    expect(pages).toEqual([1, 2]);
  });

  it('reflects a changed wird size (not delivered yet)', async () => {
    h.getWird.mockResolvedValue(manyPages(7));
    const pages = await wirdPageNumbersFor(
      { id: 1, timezone: 'UTC', currentPage: 1, wirdSize: 7 },
      NOW,
    );
    expect(h.getWird).toHaveBeenCalledWith(1, 7);
    expect(pages).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('returns [] when no pages resolve', async () => {
    h.getWird.mockResolvedValue([]);
    expect(
      await wirdPageNumbersFor({ id: 1, timezone: 'UTC', currentPage: 1, wirdSize: 1 }, NOW),
    ).toEqual([]);
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

  it('a USER records the day but does NOT advance the position (no nextPage)', async () => {
    h.listDeliverableSubscribers.mockResolvedValue([sub({ kind: 'user', currentPage: 5 })]);
    await deliverDueSubscribers(fakeBot, NOW);
    expect(h.commitDelivery).toHaveBeenCalledOnce();
    const arg = h.commitDelivery.mock.calls[0][0];
    expect(arg).toMatchObject({ startPage: 5, pageCount: 1 });
    expect(arg.nextPage).toBeUndefined(); // the wird repeats until a confirmed read
  });

  it('a CHANNEL advances on send (nextPage set), the broadcast pace', async () => {
    h.listDeliverableSubscribers.mockResolvedValue([sub({ kind: 'channel', currentPage: 5 })]);
    await deliverDueSubscribers(fakeBot, NOW);
    expect(h.commitDelivery.mock.calls[0][0]).toMatchObject({
      startPage: 5,
      pageCount: 1,
      nextPage: advanceStartPage(5, 1),
    });
  });

  it('a USER records only the pages that went out on a partial send (still no advance)', async () => {
    h.listDeliverableSubscribers.mockResolvedValue([sub({ wirdSize: 2 })]);
    h.getWird.mockResolvedValue(TWO_PAGES);
    h.sendMessages.mockResolvedValueOnce('ok').mockResolvedValueOnce('failed'); // page 2 fails
    const stats = await deliverDueSubscribers(fakeBot, NOW);
    expect(h.commitDelivery.mock.calls[0][0]).toMatchObject({ pageCount: 1 });
    expect(h.commitDelivery.mock.calls[0][0].nextPage).toBeUndefined();
    expect(stats).toMatchObject({ due: 1, sent: 1, failed: 0 });
  });

  it('marks a user blocked mid-wird but still records the pages that went out', async () => {
    h.listDeliverableSubscribers.mockResolvedValue([sub({ wirdSize: 2 })]);
    h.getWird.mockResolvedValue(TWO_PAGES);
    h.sendMessages.mockResolvedValueOnce('ok').mockResolvedValueOnce('blocked'); // blocked on page 2
    const stats = await deliverDueSubscribers(fakeBot, NOW);
    expect(h.commitDelivery).toHaveBeenCalledOnce();
    expect(h.commitDelivery.mock.calls[0][0]).toMatchObject({ pageCount: 1 });
    expect(h.markBlocked).toHaveBeenCalledWith(1);
    expect(stats).toMatchObject({ due: 1, sent: 1 });
  });

  it('sends the read-confirm prompt to a USER but not a CHANNEL', async () => {
    h.listDeliverableSubscribers.mockResolvedValue([sub({ kind: 'user' })]);
    await deliverDueSubscribers(fakeBot, NOW);
    expect(apiSendMessage).toHaveBeenCalledTimes(1); // the confirm prompt
    apiSendMessage.mockClear();
    h.listDeliverableSubscribers.mockResolvedValue([sub({ kind: 'channel' })]);
    await deliverDueSubscribers(fakeBot, NOW);
    expect(apiSendMessage).not.toHaveBeenCalled(); // a broadcast gets no button
  });

  it('leads a repeating unread wird with the missed-days nudge (encouragement ayah)', async () => {
    h.countUnreadDeliveriesBefore.mockResolvedValue(2); // two missed days
    h.listDeliverableSubscribers.mockResolvedValue([sub({ kind: 'user' })]);
    await deliverDueSubscribers(fakeBot, NOW);
    // The encouragement ayah's text is fetched from the DB (picked virtue 2:27).
    expect(h.getAyahText).toHaveBeenCalledWith(2, 27);
    // The nudge text (with the ayah) goes out before the wird, as a text message.
    expect(h.sendMessages.mock.calls[0][2][0]).toContain('نص الآية');
  });

  it('sends no nudge when the reader is not behind', async () => {
    h.countUnreadDeliveriesBefore.mockResolvedValue(0);
    h.listDeliverableSubscribers.mockResolvedValue([sub({ kind: 'user' })]);
    await deliverDueSubscribers(fakeBot, NOW);
    expect(h.getAyahText).not.toHaveBeenCalled();
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

  it('sends a multi-page image wird as ONE album, in order, lead on the first item only', async () => {
    h.listDeliverableSubscribers.mockResolvedValue([
      sub({ kind: 'channel', wirdFormat: 'image', wirdSize: 2, currentPage: 1 }),
    ]);
    h.getWird.mockResolvedValue(TWO_PAGES);

    const stats = await deliverDueSubscribers(fakeBot, NOW);

    expect(h.sendPhotoAlbum).toHaveBeenCalledOnce(); // one grouped, ordered post
    expect(h.sendPhoto).not.toHaveBeenCalled();
    expect(h.sendMessages).not.toHaveBeenCalled();
    const items = h.sendPhotoAlbum.mock.calls[0][2];
    expect(items).toHaveLength(2); // page order preserved by the array
    expect(items[0].caption).toContain('🌿'); // lead on the first item
    expect(items[1].caption).toBeUndefined(); // Telegram shows only the first caption
    // Each page's returned file_id is cached, and the position advances by 2.
    expect(h.cachePageImageId).toHaveBeenCalledWith(1, 'FA1');
    expect(h.cachePageImageId).toHaveBeenCalledWith(2, 'FA2');
    expect(h.commitDelivery.mock.calls[0][0]).toMatchObject({
      pageCount: 2,
      nextPage: advanceStartPage(1, 2),
    });
    expect(stats).toMatchObject({ due: 1, sent: 1, failed: 0 });
  });

  it('falls back to per-page (image then text) when the album send fails, and still completes', async () => {
    h.listDeliverableSubscribers.mockResolvedValue([
      sub({ kind: 'channel', wirdFormat: 'image', wirdSize: 2, currentPage: 1 }),
    ]);
    h.getWird.mockResolvedValue(TWO_PAGES);
    h.sendPhotoAlbum.mockResolvedValue({ result: 'failed', fileIds: [] }); // album fails
    h.sendPhoto
      .mockResolvedValueOnce({ result: 'ok', fileId: 'F1' }) // page 1 as image
      .mockResolvedValueOnce({ result: 'failed' }); // page 2 image fails -> text

    const stats = await deliverDueSubscribers(fakeBot, NOW);

    expect(h.sendPhotoAlbum).toHaveBeenCalledOnce(); // tried the album first
    expect(h.sendPhoto).toHaveBeenCalledTimes(2); // then per-page
    expect(h.sendMessages).toHaveBeenCalledOnce(); // page 2 fell back to text
    // The whole wird is recorded and the position advances by 2 (no page lost).
    expect(h.commitDelivery.mock.calls[0][0]).toMatchObject({
      pageCount: 2,
      nextPage: advanceStartPage(1, 2),
    });
    expect(stats).toMatchObject({ due: 1, sent: 1, failed: 0 });
  });

  it('splits a >10-page image wird into multiple albums (lead on the first album only)', async () => {
    // wirdSize 12 > MAX_ALBUM_SIZE (10): the wird is sent as two albums, 10 + 2.
    h.listDeliverableSubscribers.mockResolvedValue([
      sub({ kind: 'channel', wirdFormat: 'image', wirdSize: 12, currentPage: 1 }),
    ]);
    h.getWird.mockResolvedValue(manyPages(12));

    const stats = await deliverDueSubscribers(fakeBot, NOW);

    expect(h.sendPhotoAlbum).toHaveBeenCalledTimes(2);
    const first = h.sendPhotoAlbum.mock.calls[0][2];
    const second = h.sendPhotoAlbum.mock.calls[1][2];
    expect(first).toHaveLength(10);
    expect(second).toHaveLength(2);
    expect(first[0].caption).toContain('🌿'); // the wird lead, on the very first item
    expect(second[0].caption).not.toContain('🌿'); // later albums carry no lead
    expect(second[1].caption).toBeUndefined(); // only the first item of an album captions
    expect(h.sendPhoto).not.toHaveBeenCalled();
    expect(h.sendMessages).not.toHaveBeenCalled();
    // All 12 pages went out; the position advances by 12.
    expect(h.cachePageImageId).toHaveBeenCalledWith(1, 'FA1');
    expect(h.cachePageImageId).toHaveBeenCalledWith(12, 'FA2'); // 2nd item of the 2nd album
    expect(h.commitDelivery.mock.calls[0][0]).toMatchObject({
      pageCount: 12,
      nextPage: advanceStartPage(1, 12),
    });
    expect(stats).toMatchObject({ due: 1, sent: 1, failed: 0 });
  });

  it('advances by only the pages sent when a later album AND its text fallback fail', async () => {
    h.listDeliverableSubscribers.mockResolvedValue([
      sub({ kind: 'channel', wirdFormat: 'image', wirdSize: 12, currentPage: 1 }),
    ]);
    h.getWird.mockResolvedValue(manyPages(12));
    // First album (10 pages) ok; the second album fails, and its per-page
    // fallback fails as photo AND as text (a real outage), so only 10 went out.
    h.sendPhotoAlbum
      .mockResolvedValueOnce({
        result: 'ok',
        fileIds: Array.from({ length: 10 }, (_, i) => `FA${i + 1}`),
      })
      .mockResolvedValueOnce({ result: 'failed', fileIds: [] });
    h.sendPhoto.mockResolvedValue({ result: 'failed' });
    h.sendMessages.mockResolvedValue('failed');

    const stats = await deliverDueSubscribers(fakeBot, NOW);

    expect(h.sendPhotoAlbum).toHaveBeenCalledTimes(2);
    // Recorded as exactly the 10 pages that arrived; the rest roll to next run.
    expect(h.commitDelivery.mock.calls[0][0]).toMatchObject({
      pageCount: 10,
      nextPage: advanceStartPage(1, 10),
    });
    expect(stats).toMatchObject({ due: 1, sent: 1 });
  });
});

describe('deliverDueSubscribers (tajweed lesson)', () => {
  it('sends the lesson BEFORE the wird and advances the lesson on success', async () => {
    h.listDeliverableSubscribers.mockResolvedValue([
      sub({ wirdFormat: 'text', tajweedEnabled: true, tajweedLessonIndex: 0 }),
    ]);
    const stats = await deliverDueSubscribers(fakeBot, NOW);

    // Two text sends: the lesson FIRST, then the one-page wird.
    expect(h.sendMessages).toHaveBeenCalledTimes(2);
    expect(h.sendMessages.mock.calls[0][2][0]).toContain('درس التجويد اليوم'); // lesson is first
    // The day is committed and the lesson advances 0 -> 1.
    expect(h.commitDelivery.mock.calls[0][0]).toMatchObject({ nextLessonIndex: 1 });
    expect(stats).toMatchObject({ due: 1, sent: 1 });
  });

  it('does NOT advance the lesson when the lesson send fails (wird still goes)', async () => {
    h.listDeliverableSubscribers.mockResolvedValue([
      sub({ wirdFormat: 'text', tajweedEnabled: true, tajweedLessonIndex: 0 }),
    ]);
    // Lesson text fails, the wird text then succeeds.
    h.sendMessages.mockResolvedValueOnce('failed').mockResolvedValue('ok');

    await deliverDueSubscribers(fakeBot, NOW);

    // The wird was still committed, but the lesson index did not move.
    expect(h.commitDelivery).toHaveBeenCalledOnce();
    expect(h.commitDelivery.mock.calls[0][0].nextLessonIndex).toBeUndefined();
  });

  it('sends no lesson when the subscriber has it turned off', async () => {
    h.listDeliverableSubscribers.mockResolvedValue([
      sub({ wirdFormat: 'text', tajweedEnabled: false }),
    ]);
    await deliverDueSubscribers(fakeBot, NOW);

    // Only the wird went out (one text send), and no lesson advance.
    expect(h.sendMessages).toHaveBeenCalledOnce();
    expect(h.commitDelivery.mock.calls[0][0].nextLessonIndex).toBeUndefined();
  });

  it('attaches the example audio when a source is configured, caching its file_id', async () => {
    mutableConfig.tajweedAudioBaseUrl = 'https://x/{surah3}{ayah3}.mp3';
    h.listDeliverableSubscribers.mockResolvedValue([
      sub({ wirdFormat: 'text', tajweedEnabled: true, tajweedLessonIndex: 0 }),
    ]);
    await deliverDueSubscribers(fakeBot, NOW);

    // Lesson 0's example is (2, 27): audio fetched from the built URL and cached.
    expect(h.sendAudio).toHaveBeenCalledOnce();
    expect(h.sendAudio.mock.calls[0][2]).toBe('https://x/002027.mp3');
    // Silent: a quiet companion to the lesson text that just notified.
    expect(h.sendAudio.mock.calls[0][3]).toMatchObject({ silent: true });
    expect(h.cacheTajweedAudioId).toHaveBeenCalledWith(2, 27, 'AUDIO_1');
  });
});

describe('buildLessonReview', () => {
  it('renders every lesson with its example text and audio filename', async () => {
    const doc = await buildLessonReview();
    // Header + every lesson title from the fake deck.
    expect(doc).toContain('مراجعة دروس التجويد');
    expect(doc).toContain('الإقلاب');
    expect(doc).toContain('الإظهار');
    expect(doc).toContain('المد');
    // The example ayah's verified text (from getAyahText) is included.
    expect(doc).toContain('نص الآية');
    // Audio filenames are derived from each lesson's (surah, ayah).
    expect(doc).toContain('002027.mp3'); // lesson 0 -> (2,27)
    expect(doc).toContain('001007.mp3'); // lesson 1 -> (1,7)
    // It covers the whole deck.
    expect(doc).toContain('من ٣'); // "lesson N of 3"
  });

  it('flags an example ayah that is missing from the database', async () => {
    h.getAyahText.mockResolvedValue(null);
    const doc = await buildLessonReview();
    expect(doc).toContain('غير موجود في قاعدة البيانات');
  });
});

describe('deliverDueSubscribers (page recitation)', () => {
  it('sends a page recitation after the wird in the chosen reciter, and caches it', async () => {
    h.listDeliverableSubscribers.mockResolvedValue([
      sub({ wirdFormat: 'text', wirdAudioEnabled: true, reciter: 'husary', currentPage: 1 }),
    ]);
    await deliverDueSubscribers(fakeBot, NOW);

    // getWird (mocked) returns page 1; the audio is fetched from everyayah in
    // Husary's voice and the returned file_id is cached.
    expect(h.sendAudio).toHaveBeenCalledOnce();
    expect(h.sendAudio.mock.calls[0][2]).toBe(
      'https://everyayah.com/data/Husary_128kbps/PageMp3s/Page001.mp3',
    );
    // Silent: a quiet companion to the wird that just notified (matches ayah).
    expect(h.sendAudio.mock.calls[0][3]).toMatchObject({ silent: true });
    expect(h.cachePageAudioId).toHaveBeenCalledWith(1, 'husary', 'AUDIO_1');
  });

  it('sends one recitation PER page, in order, for a multi-page wird', async () => {
    // The case after a user raises their wird size: a juz-sized wird still gets
    // one audio clip per page, in reading order, each cached under its own page.
    h.listDeliverableSubscribers.mockResolvedValue([
      sub({
        wirdFormat: 'text',
        wirdSize: 2,
        wirdAudioEnabled: true,
        reciter: 'husary',
        currentPage: 1,
      }),
    ]);
    h.getWird.mockResolvedValue(TWO_PAGES);
    await deliverDueSubscribers(fakeBot, NOW);

    expect(h.sendAudio).toHaveBeenCalledTimes(2);
    expect(h.sendAudio.mock.calls[0][2]).toBe(
      'https://everyayah.com/data/Husary_128kbps/PageMp3s/Page001.mp3',
    );
    expect(h.sendAudio.mock.calls[1][2]).toBe(
      'https://everyayah.com/data/Husary_128kbps/PageMp3s/Page002.mp3',
    );
    expect(h.cachePageAudioId).toHaveBeenCalledWith(1, 'husary', 'AUDIO_1');
    expect(h.cachePageAudioId).toHaveBeenCalledWith(2, 'husary', 'AUDIO_1');
  });

  it('recites only the pages that actually went out on a partial multi-page wird', async () => {
    // Page 2 fails to send, so the wird records 1 page — and the recitation must
    // follow exactly the pages delivered, never the unsent ones.
    h.listDeliverableSubscribers.mockResolvedValue([
      sub({
        wirdFormat: 'text',
        wirdSize: 2,
        wirdAudioEnabled: true,
        reciter: 'husary',
        currentPage: 1,
      }),
    ]);
    h.getWird.mockResolvedValue(TWO_PAGES);
    // First sendMessages is the wird's page 1 (ok), second is page 2 (failed).
    h.sendMessages.mockResolvedValueOnce('ok').mockResolvedValueOnce('failed');
    await deliverDueSubscribers(fakeBot, NOW);

    expect(h.commitDelivery.mock.calls[0][0]).toMatchObject({ pageCount: 1 });
    expect(h.sendAudio).toHaveBeenCalledOnce(); // only page 1's recitation
    expect(h.sendAudio.mock.calls[0][2]).toBe(
      'https://everyayah.com/data/Husary_128kbps/PageMp3s/Page001.mp3',
    );
  });

  it('sends no recitation when the subscriber turned it off', async () => {
    h.listDeliverableSubscribers.mockResolvedValue([
      sub({ wirdFormat: 'text', wirdAudioEnabled: false }),
    ]);
    await deliverDueSubscribers(fakeBot, NOW);
    expect(h.sendAudio).not.toHaveBeenCalled();
  });

  it('reuses a cached page-audio file_id and does not re-cache it', async () => {
    h.listDeliverableSubscribers.mockResolvedValue([
      sub({ wirdFormat: 'text', wirdAudioEnabled: true, reciter: 'husary', currentPage: 1 }),
    ]);
    h.getCachedPageAudioId.mockResolvedValue('CACHED_PAGE');
    h.sendAudio.mockResolvedValue({ result: 'ok', fileId: 'CACHED_PAGE' });
    await deliverDueSubscribers(fakeBot, NOW);

    expect(h.sendAudio.mock.calls[0][2]).toBe('CACHED_PAGE'); // sent by file_id
    expect(h.cachePageAudioId).not.toHaveBeenCalled();
  });
});

describe('renderLessonAt (lessons browser)', () => {
  // The mocked deck has 3 lessons (h.lessons); getAyahText returns a fixture.
  it('renders a lesson by deck index with a "lesson N of M" header (not "today")', async () => {
    const text = await renderLessonAt(0);
    expect(text).toContain('الدرس ١ من ٣: الإقلاب');
    expect(text).not.toContain('اليوم'); // a browsed lesson is not today's
    expect(text).toContain('قاعدة الإقلاب.'); // the body
  });

  it('picks the lesson at the given index', async () => {
    expect(await renderLessonAt(1)).toContain('الإظهار');
  });

  it('wraps an out-of-range index into the deck (3 lessons: index 5 -> 2)', async () => {
    const text = await renderLessonAt(5);
    expect(text).toContain('الدرس ٣ من ٣: المد');
  });

  it('returns null when the example ayah is not seeded', async () => {
    h.getAyahText.mockResolvedValueOnce(null);
    expect(await renderLessonAt(0)).toBeNull();
  });
});

describe('deliverDueSubscribers (a large, juz-sized wird and the confirm prompt)', () => {
  it('a USER 20-page wird: 20 pages out, one recitation each, ONE silent confirm prompt, no advance', async () => {
    h.listDeliverableSubscribers.mockResolvedValue([
      sub({
        wirdFormat: 'text',
        wirdSize: 20,
        currentPage: 1,
        wirdAudioEnabled: true,
        reciter: 'husary',
      }),
    ]);
    h.getWird.mockResolvedValue(manyPages(20));
    const stats = await deliverDueSubscribers(fakeBot, NOW);

    expect(h.sendMessages).toHaveBeenCalledTimes(20); // one text message per page
    expect(h.sendAudio).toHaveBeenCalledTimes(20); // one silent clip per page
    // Recorded once, all 20 pages; the position does NOT advance (read-gated),
    // so the whole juz repeats until the reader confirms.
    expect(h.commitDelivery).toHaveBeenCalledOnce();
    expect(h.commitDelivery.mock.calls[0][0]).toMatchObject({ pageCount: 20 });
    expect(h.commitDelivery.mock.calls[0][0].nextPage).toBeUndefined();
    expect(stats).toMatchObject({ due: 1, sent: 1 });
  });

  it('the confirm prompt is exactly one message, sent silently (one buzz per day)', async () => {
    h.listDeliverableSubscribers.mockResolvedValue([
      sub({ wirdFormat: 'text', wirdSize: 20, currentPage: 1 }),
    ]);
    h.getWird.mockResolvedValue(manyPages(20));
    await deliverDueSubscribers(fakeBot, NOW);

    expect(apiSendMessage).toHaveBeenCalledTimes(1); // one button for the whole wird
    expect(apiSendMessage.mock.calls[0][2]).toMatchObject({ disable_notification: true });
  });
});
