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
