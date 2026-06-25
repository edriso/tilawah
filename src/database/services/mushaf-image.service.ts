import { prisma } from '../client';
import { DEFAULT_RIWAYAH, type RiwayahKey } from '../../core';

// The Telegram file_id cache for Madani Mushaf page images (the "image"
// delivery format). The first time a page goes out as a photo, Telegram
// fetches it from the configured source and hands back a file_id; we store it
// here and reuse it on every later send, so the source only has to be reachable
// once per page and we never re-upload. Keyed by (riwayah, page): a Warsh page
// is a different image from the Hafs page of the same number. See
// MushafPageImage in the schema.

/**
 * The cached file_ids for the given pages in a riwayah, as a `page -> file_id`
 * map. Pages not yet cached are simply absent. One query for the whole wird.
 */
export async function getCachedPageImageIds(
  pages: number[],
  riwayah: RiwayahKey = DEFAULT_RIWAYAH,
): Promise<Map<number, string>> {
  const distinct = [...new Set(pages)];
  if (distinct.length === 0) return new Map();
  const rows = await prisma.mushafPageImage.findMany({
    where: { riwayah, page: { in: distinct } },
    select: { page: true, fileId: true },
  });
  return new Map(rows.map((r) => [r.page, r.fileId]));
}

/**
 * Remember the file_id Telegram returned for a page, so later sends reference
 * it instead of re-fetching the source. Upsert: the id can change if the source
 * image is replaced and the row is re-seeded, and a concurrent first-send for
 * the same page must not error.
 */
export function cachePageImageId(
  page: number,
  fileId: string,
  riwayah: RiwayahKey = DEFAULT_RIWAYAH,
) {
  return prisma.mushafPageImage.upsert({
    where: { riwayah_page: { riwayah, page } },
    update: { fileId },
    create: { riwayah, page, fileId },
  });
}

/** Build the Prisma `where` for the cache filters (ANDed; empty = match all).
 *  Shared by the clear and count helpers so they always agree on the scope.
 *  Mirrors page-audio.service's pageAudioWhere. */
function mushafImageWhere(filter: { riwayah?: RiwayahKey; page?: number }) {
  const where: { riwayah?: string; page?: number } = {};
  if (filter.riwayah !== undefined) where.riwayah = filter.riwayah;
  if (filter.page !== undefined) where.page = filter.page;
  return where;
}

/**
 * Drop cached page-image file_ids so the NEXT send re-uploads from the CURRENT
 * source. Use this after replacing a riwayah's page images (e.g. swapping the
 * Hafs set for a verified KFGQPC PDF render): the cached file_id points at
 * Telegram's stored copy of the OLD image and would be re-served forever
 * otherwise. Filters are ANDed; omit them to clear the whole cache. Returns how
 * many rows were removed. The audio twin is clearCachedPageAudio. See
 * scripts/clear-mushaf-images.ts.
 */
export async function clearCachedPageImages(
  filter: { riwayah?: RiwayahKey; page?: number } = {},
): Promise<number> {
  const { count } = await prisma.mushafPageImage.deleteMany({ where: mushafImageWhere(filter) });
  return count;
}

/** Count cached rows matching the same filter WITHOUT deleting — the dry-run
 *  preview for the clear script, so an operator sees the blast radius first. */
export function countCachedPageImages(
  filter: { riwayah?: RiwayahKey; page?: number } = {},
): Promise<number> {
  return prisma.mushafPageImage.count({ where: mushafImageWhere(filter) });
}
