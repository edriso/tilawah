// Pure helpers for the page-audio generator and verifier. No network, no
// ffmpeg, no filesystem, so the page->ayat math is unit-tested on its own.
//
// The whole point of the generator is correctness: a page clip must contain
// EXACTLY the ayat our Madani layout puts on that page (the same layout the wird
// text uses), built from the trusted per-ayah recitations. everyayah's pre-split
// PageMp3s do NOT guarantee this (e.g. Abdul Basit's Page011 drops 2:76), which
// is the whole reason we self-host a verified set.

/** One ayah's position: its surah and its number within that surah. */
export interface PageAyah {
  surah: number;
  ayah: number;
}

/** The shape of prisma/data/quran-uthmani.json that we read (ayat are ordered;
 *  the array index + 1 is the ayah's number within its surah). */
export interface QuranData {
  surahs: { number: number; ayat: { page: number }[] }[];
}

/**
 * Build `page -> ordered ayat` from the seeded Quran data. This is the single
 * source of truth for "which ayat are on page N", matching what the wird text
 * shows (both derive from the same data). The generator concatenates exactly
 * these ayat per page; the verifier checks against them.
 */
export function buildPageAyat(quran: QuranData): Map<number, PageAyah[]> {
  const map = new Map<number, PageAyah[]>();
  for (const surah of quran.surahs) {
    surah.ayat.forEach((a, i) => {
      const list = map.get(a.page);
      const entry: PageAyah = { surah: surah.number, ayah: i + 1 };
      if (list) list.push(entry);
      else map.set(a.page, [entry]);
    });
  }
  return map;
}

/** Zero-pad a number to 3 digits (1 -> "001", 11 -> "011", 604 -> "604"). */
export function pad3(n: number): string {
  return String(n).padStart(3, '0');
}

/** The file name for a page's clip in the self-hosted set: "Page011.mp3". This
 *  matches the {page3} the runtime template fills, so the bot finds the file. */
export function pageFileName(page: number): string {
  return `Page${pad3(page)}.mp3`;
}
