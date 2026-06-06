import { prisma } from '../client';

// The Telegram file_id cache for the per-ayah tajweed example audio clips, the
// audio twin of mushaf-image.service. The first time a clip goes out, Telegram
// fetches/uploads it from the configured source and hands back a file_id; we
// store it keyed by the (surah, ayah) it recites and reuse it forever. See
// TajweedAudio in the schema.

/** The cached file_id for one example ayah, or null if not cached yet. */
export async function getCachedTajweedAudioId(
  surahNumber: number,
  numberInSurah: number,
): Promise<string | null> {
  const row = await prisma.tajweedAudio.findUnique({
    where: { surahNumber_numberInSurah: { surahNumber, numberInSurah } },
    select: { fileId: true },
  });
  return row?.fileId ?? null;
}

/**
 * Remember the file_id Telegram returned for an example ayah's clip. Upsert:
 * the id can change if the source clip is replaced, and a concurrent first-send
 * for the same ayah must not error.
 */
export function cacheTajweedAudioId(surahNumber: number, numberInSurah: number, fileId: string) {
  return prisma.tajweedAudio.upsert({
    where: { surahNumber_numberInSurah: { surahNumber, numberInSurah } },
    update: { fileId },
    create: { surahNumber, numberInSurah, fileId },
  });
}
