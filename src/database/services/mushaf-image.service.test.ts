import { describe, it, expect, beforeEach, vi } from 'vitest';

// Stub only the Prisma client; the functions under test are the cache key/filter
// logic around findMany/upsert/deleteMany/count.
const h = vi.hoisted(() => ({
  findMany: vi.fn(),
  upsert: vi.fn(),
  deleteMany: vi.fn(),
  count: vi.fn(),
}));
vi.mock('../client', () => ({
  prisma: {
    mushafPageImage: {
      findMany: h.findMany,
      upsert: h.upsert,
      deleteMany: h.deleteMany,
      count: h.count,
    },
  },
}));

import {
  getCachedPageImageIds,
  cachePageImageId,
  clearCachedPageImages,
  countCachedPageImages,
} from './mushaf-image.service';

beforeEach(() => vi.clearAllMocks());

describe('getCachedPageImageIds', () => {
  it('queries by (riwayah, distinct pages) and returns a page -> file_id map', async () => {
    h.findMany.mockResolvedValue([
      { page: 1, fileId: 'a' },
      { page: 2, fileId: 'b' },
    ]);
    const map = await getCachedPageImageIds([1, 2, 2], 'hafs');
    expect(map.get(1)).toBe('a');
    expect(map.get(2)).toBe('b');
    expect(h.findMany).toHaveBeenCalledWith({
      where: { riwayah: 'hafs', page: { in: [1, 2] } },
      select: { page: true, fileId: true },
    });
  });

  it('defaults the riwayah to hafs and short-circuits on no pages', async () => {
    const map = await getCachedPageImageIds([]);
    expect(map.size).toBe(0);
    expect(h.findMany).not.toHaveBeenCalled();
  });
});

describe('cachePageImageId', () => {
  it('upserts the file_id under the (riwayah, page) key', () => {
    cachePageImageId(25, 'fid', 'qaloon');
    expect(h.upsert).toHaveBeenCalledWith({
      where: { riwayah_page: { riwayah: 'qaloon', page: 25 } },
      update: { fileId: 'fid' },
      create: { riwayah: 'qaloon', page: 25, fileId: 'fid' },
    });
  });
});

describe('clearCachedPageImages (after replacing a source)', () => {
  it('filters by riwayah and page (ANDed) and returns the count', async () => {
    h.deleteMany.mockResolvedValue({ count: 4 });
    const n = await clearCachedPageImages({ riwayah: 'hafs', page: 1 });
    expect(n).toBe(4);
    expect(h.deleteMany).toHaveBeenCalledWith({ where: { riwayah: 'hafs', page: 1 } });
  });

  it('clears EVERYTHING when given no filter (empty where)', async () => {
    h.deleteMany.mockResolvedValue({ count: 99 });
    await clearCachedPageImages();
    expect(h.deleteMany).toHaveBeenCalledWith({ where: {} });
  });
});

describe('countCachedPageImages (the dry-run preview)', () => {
  it('counts with the same filter shape, without deleting', async () => {
    h.count.mockResolvedValue(604);
    expect(await countCachedPageImages({ riwayah: 'hafs' })).toBe(604);
    expect(h.count).toHaveBeenCalledWith({ where: { riwayah: 'hafs' } });
    expect(h.deleteMany).not.toHaveBeenCalled();
  });
});
