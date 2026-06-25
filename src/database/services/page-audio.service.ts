import { prisma } from '../client';
import { DEFAULT_RIWAYAH, type RiwayahKey } from '../../core';

// The Telegram file_id cache for page-recitation clips, the audio twin of
// mushaf-image.service. The first time a page goes out in a given reciter's
// voice, Telegram fetches it from the source and hands back a file_id; we store
// it keyed by (riwayah, page, reciter) and reuse it forever. The riwayah is part
// of the key because a page's recitation differs per riwayah. See PageAudio.

/** The cached file_id for one (riwayah, page, reciter), or null if not cached. */
export async function getCachedPageAudioId(
  page: number,
  reciter: string,
  riwayah: RiwayahKey = DEFAULT_RIWAYAH,
): Promise<string | null> {
  const row = await prisma.pageAudio.findUnique({
    where: { riwayah_page_reciter: { riwayah, page, reciter } },
    select: { fileId: true },
  });
  return row?.fileId ?? null;
}

/**
 * Remember the file_id Telegram returned for a page+reciter clip. Upsert: the
 * id can change if the source clip is replaced, and a concurrent first-send for
 * the same page must not error.
 */
export function cachePageAudioId(
  page: number,
  reciter: string,
  fileId: string,
  riwayah: RiwayahKey = DEFAULT_RIWAYAH,
) {
  return prisma.pageAudio.upsert({
    where: { riwayah_page_reciter: { riwayah, page, reciter } },
    update: { fileId },
    create: { riwayah, page, reciter, fileId },
  });
}

/** Build the Prisma `where` for the cache filters (ANDed; empty = match all).
 *  Shared by the clear and count helpers so they always agree on the scope. */
function pageAudioWhere(filter: { reciters?: string[]; riwayah?: RiwayahKey; page?: number }) {
  const where: { reciter?: { in: string[] }; riwayah?: string; page?: number } = {};
  if (filter.reciters?.length) where.reciter = { in: filter.reciters };
  if (filter.riwayah !== undefined) where.riwayah = filter.riwayah;
  if (filter.page !== undefined) where.page = filter.page;
  return where;
}

/**
 * Drop cached page-audio file_ids so the NEXT send re-uploads from the current
 * source. Use this after swapping the source for a reciter (e.g. hosting a
 * verified self-hosted set in place of the everyayah fallback): the cached
 * file_id points at Telegram's stored copy of the OLD clip and would be
 * re-served forever otherwise. Filters are ANDed; omit them to clear the whole
 * cache. Returns how many rows were removed. See scripts/clear-page-audio.ts.
 */
export async function clearCachedPageAudio(
  filter: { reciters?: string[]; riwayah?: RiwayahKey; page?: number } = {},
): Promise<number> {
  const { count } = await prisma.pageAudio.deleteMany({ where: pageAudioWhere(filter) });
  return count;
}

/** Count cached rows matching the same filter WITHOUT deleting — the dry-run
 *  preview for the clear script, so an operator sees the blast radius first. */
export function countCachedPageAudio(
  filter: { reciters?: string[]; riwayah?: RiwayahKey; page?: number } = {},
): Promise<number> {
  return prisma.pageAudio.count({ where: pageAudioWhere(filter) });
}
