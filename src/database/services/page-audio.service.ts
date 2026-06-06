import { prisma } from '../client';

// The Telegram file_id cache for page-recitation clips, the audio twin of
// mushaf-image.service. The first time a page goes out in a given reciter's
// voice, Telegram fetches it from the source (everyayah) and hands back a
// file_id; we store it keyed by (page, reciter) and reuse it forever. See
// PageAudio in the schema.

/** The cached file_id for one page+reciter, or null if not cached yet. */
export async function getCachedPageAudioId(page: number, reciter: string): Promise<string | null> {
  const row = await prisma.pageAudio.findUnique({
    where: { page_reciter: { page, reciter } },
    select: { fileId: true },
  });
  return row?.fileId ?? null;
}

/**
 * Remember the file_id Telegram returned for a page+reciter clip. Upsert: the
 * id can change if the source clip is replaced, and a concurrent first-send for
 * the same page must not error.
 */
export function cachePageAudioId(page: number, reciter: string, fileId: string) {
  return prisma.pageAudio.upsert({
    where: { page_reciter: { page, reciter } },
    update: { fileId },
    create: { page, reciter, fileId },
  });
}
