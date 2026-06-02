// Plain domain types used by the pure logic in this package.
//
// These are deliberately NOT the Prisma model types. Keeping them separate
// means the core logic can be unit-tested with tiny hand-made objects and
// never has to import the database package. The database package maps its
// rows onto these shapes when it calls into here.

// The scheduling types live in the shared kernel; re-exported so existing
// imports of '../core' (and './types') keep working unchanged.
export type { DeliverySchedule, LocalContext } from 'telegram-bot-kit';

/** A single ayah as it sits on a Mushaf page, ready to be shown. */
export interface PageAyah {
  /** Surah number (1-114) this ayah belongs to. */
  surahNumber: number;
  /** Arabic surah name, e.g. "البقرة". */
  surahNameAr: string;
  /** Ayah number inside its surah (1-based). */
  numberInSurah: number;
  /** The Uthmani text of the ayah (no basmala merged in). */
  text: string;
}

/** One Mushaf page: its number, its juz, and the ayat printed on it. */
export interface PageContent {
  /** Madani Mushaf page number (1-604). */
  pageNumber: number;
  /** Juz the page STARTS in (the juz of its first ayah, 1-30). */
  juz: number;
  /**
   * Juz the page ENDS in. Equal to `juz` for almost every page; greater only
   * for the few pages that straddle a juz boundary (e.g. page 62 spans juz
   * 3-4). Optional so callers that don't track it (tests, previews) can omit
   * it, in which case the page is treated as sitting in a single juz.
   */
  juzEnd?: number;
  /** The ayat on this page, in reading order. */
  ayat: PageAyah[];
}
