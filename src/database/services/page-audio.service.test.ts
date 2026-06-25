import { describe, it, expect, beforeEach, vi } from 'vitest';

// Stub only the Prisma client; the functions under test are the cache key/filter
// logic around findUnique/upsert/deleteMany/count.
const h = vi.hoisted(() => ({
  findUnique: vi.fn(),
  upsert: vi.fn(),
  deleteMany: vi.fn(),
  count: vi.fn(),
}));
vi.mock('../client', () => ({
  prisma: {
    pageAudio: {
      findUnique: h.findUnique,
      upsert: h.upsert,
      deleteMany: h.deleteMany,
      count: h.count,
    },
  },
}));

import {
  getCachedPageAudioId,
  cachePageAudioId,
  clearCachedPageAudio,
  countCachedPageAudio,
} from './page-audio.service';

beforeEach(() => vi.clearAllMocks());

describe('getCachedPageAudioId', () => {
  it('keys by (riwayah, page, reciter) and returns the file_id', async () => {
    h.findUnique.mockResolvedValue({ fileId: 'abc' });
    expect(await getCachedPageAudioId(383, 'alafasy', 'hafs')).toBe('abc');
    expect(h.findUnique).toHaveBeenCalledWith({
      where: { riwayah_page_reciter: { riwayah: 'hafs', page: 383, reciter: 'alafasy' } },
      select: { fileId: true },
    });
  });

  it('defaults the riwayah to hafs and returns null when not cached', async () => {
    h.findUnique.mockResolvedValue(null);
    expect(await getCachedPageAudioId(1, 'abdulbasit')).toBeNull();
    expect(h.findUnique.mock.calls[0][0].where.riwayah_page_reciter.riwayah).toBe('hafs');
  });
});

describe('cachePageAudioId', () => {
  it('upserts the file_id under the (riwayah, page, reciter) key', () => {
    cachePageAudioId(383, 'alafasy', 'fid', 'hafs');
    expect(h.upsert).toHaveBeenCalledWith({
      where: { riwayah_page_reciter: { riwayah: 'hafs', page: 383, reciter: 'alafasy' } },
      update: { fileId: 'fid' },
      create: { riwayah: 'hafs', page: 383, reciter: 'alafasy', fileId: 'fid' },
    });
  });
});

describe('clearCachedPageAudio (after swapping a source)', () => {
  it('filters by reciter list, riwayah, and page (all ANDed) and returns the count', async () => {
    h.deleteMany.mockResolvedValue({ count: 3 });
    const n = await clearCachedPageAudio({
      reciters: ['alafasy', 'husary'],
      riwayah: 'hafs',
      page: 383,
    });
    expect(n).toBe(3);
    expect(h.deleteMany).toHaveBeenCalledWith({
      where: { reciter: { in: ['alafasy', 'husary'] }, riwayah: 'hafs', page: 383 },
    });
  });

  it('clears EVERYTHING when given no filter (empty where)', async () => {
    h.deleteMany.mockResolvedValue({ count: 99 });
    await clearCachedPageAudio();
    expect(h.deleteMany).toHaveBeenCalledWith({ where: {} });
  });

  it('omits the reciter clause for an empty reciter list (does not match nothing)', async () => {
    h.deleteMany.mockResolvedValue({ count: 0 });
    await clearCachedPageAudio({ reciters: [] });
    expect(h.deleteMany).toHaveBeenCalledWith({ where: {} });
  });
});

describe('countCachedPageAudio (the dry-run preview)', () => {
  it('counts with the same filter shape, without deleting', async () => {
    h.count.mockResolvedValue(7);
    expect(await countCachedPageAudio({ reciters: ['alafasy'] })).toBe(7);
    expect(h.count).toHaveBeenCalledWith({ where: { reciter: { in: ['alafasy'] } } });
    expect(h.deleteMany).not.toHaveBeenCalled();
  });
});
