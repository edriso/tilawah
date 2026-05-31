// Independent verification constants for the Madani Mushaf layout.
//
// The page and juz numbers come from a trusted source at fetch time, but we
// never trust a download blindly: the fetch script and the startup check
// assert these exact numbers and anchors. If a source ever shifts to a
// different layout, the mismatch stops us loudly before any reader sees a
// wrong page.

/** Pages in the standard Madani Mushaf (King Fahd Complex layout). */
export const PAGE_COUNT = 604;

/** Ajzaa (juz) in the Quran. */
export const JUZ_COUNT = 30;

/**
 * Well-known anchors used to confirm we have the standard Madani layout and
 * not some other edition. Each is { surah, ayah } that MUST sit on the given
 * page or open the given juz.
 */
export const PAGE_ANCHORS = [
  { page: 1, surah: 1, ayah: 1 }, // Al-Fatihah opens page 1
  { page: 2, surah: 2, ayah: 1 }, // Al-Baqarah opens page 2
  { page: 604, surah: 112, ayah: 1 }, // the last page opens with Al-Ikhlas (112-114 sit on it)
] as const;

export const JUZ_ANCHORS = [
  { juz: 1, surah: 1, ayah: 1 }, // Juz 1 opens with Al-Fatihah
  { juz: 30, surah: 78, ayah: 1 }, // Juz 30 ('Amma) opens with An-Naba'
] as const;
