// Wird math: walking the Quran one daily portion (wird) at a time.
//
// A wird is a number of Mushaf pages. A subscriber has a current page (the
// next page to read) and a wird size (how many pages per day). After each
// send we move the current page forward by the wird size, wrapping from the
// last page back to page 1 so reading loops forever.
//
// All pure functions, fully testable. Page numbers are 1-based (1..604).

/** Pages in the standard Madani Mushaf. The whole engine counts in pages. */
export const TOTAL_PAGES = 604;

/** Default wird: one page a day. Gentle, the recommended start for beginners. */
export const DEFAULT_WIRD_PAGES = 1;

/** Smallest wird a subscriber can set. */
export const MIN_WIRD_PAGES = 1;

/**
 * Largest wird a subscriber can set: 20 pages, about one juz a day, which
 * finishes the Quran in ~30 days (a monthly khatma). We cap here on purpose:
 * scholars caution against finishing the whole Quran in fewer than three
 * days, and a juz a day already covers everyone from a cautious beginner to a
 * monthly reader. Kept as a constant so the cap can change in one place.
 */
export const MAX_WIRD_PAGES = 20;

/** Force any number into the allowed wird-size range (1..20). */
export function clampWirdSize(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_WIRD_PAGES;
  const n = Math.trunc(value);
  if (n < MIN_WIRD_PAGES) return MIN_WIRD_PAGES;
  if (n > MAX_WIRD_PAGES) return MAX_WIRD_PAGES;
  return n;
}

/** True if a number is a whole page number in range (1..total). */
export function isValidPage(value: number, total = TOTAL_PAGES): boolean {
  return Number.isInteger(value) && value >= 1 && value <= total;
}

/**
 * The list of page numbers in one wird, starting at `startPage` and taking
 * `size` pages, wrapping past the last page back to page 1.
 *
 *   pagesForWird(1, 1)    -> [1]
 *   pagesForWird(603, 3)  -> [603, 604, 1]   (wraps cleanly at the end)
 *   pagesForWird(604, 2)  -> [604, 1]
 *
 * `size` is clamped to the allowed range so a bad value can never produce a
 * huge or empty list.
 */
export function pagesForWird(startPage: number, size: number, total = TOTAL_PAGES): number[] {
  if (!isValidPage(startPage, total)) {
    throw new Error(`startPage must be 1..${total}, got ${startPage}`);
  }
  const n = clampWirdSize(size);
  const pages: number[] = [];
  for (let i = 0; i < n; i++) {
    // 0-based arithmetic with a modulo, then back to 1-based.
    pages.push(((startPage - 1 + i) % total) + 1);
  }
  return pages;
}

/**
 * The page a subscriber lands on AFTER reading a wird of `size` pages that
 * started at `startPage`. This is where tomorrow's wird begins. Wraps past
 * the last page back to page 1.
 *
 *   advanceStartPage(1, 1)    -> 2
 *   advanceStartPage(604, 1)  -> 1     (loops back to the start)
 *   advanceStartPage(603, 3)  -> 2     (603,604,1 read; next is 2)
 */
export function advanceStartPage(startPage: number, size: number, total = TOTAL_PAGES): number {
  if (!isValidPage(startPage, total)) {
    throw new Error(`startPage must be 1..${total}, got ${startPage}`);
  }
  const n = clampWirdSize(size);
  return ((startPage - 1 + n) % total) + 1;
}

/**
 * The page to start from given the LAST page a reader finished, used by the
 * channel admin command "last page read = X". The next post begins at the
 * page after X, wrapping 604 -> 1.
 *
 *   nextPageAfter(50)   -> 51
 *   nextPageAfter(604)  -> 1
 */
export function nextPageAfter(lastReadPage: number, total = TOTAL_PAGES): number {
  if (!isValidPage(lastReadPage, total)) {
    throw new Error(`lastReadPage must be 1..${total}, got ${lastReadPage}`);
  }
  return (lastReadPage % total) + 1;
}

/**
 * Roughly how many days a full khatma (one pass through the whole Quran)
 * takes at a given wird size. Used only for a friendly hint when the user
 * picks a size, e.g. "you will finish in about 30 days".
 */
export function khatmaDays(size: number, total = TOTAL_PAGES): number {
  return Math.ceil(total / clampWirdSize(size));
}
