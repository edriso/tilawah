import { InlineKeyboard } from 'grammy';
import { pageTafseerUrl } from '../core';
import { toArabicDigits } from '../core';

// The /tafsir reply's keyboard: one URL button per page of the reader's wird,
// each opening that Mushaf page's tafseer on quran.com. URL buttons (not text
// callbacks) open the browser directly. A few per row so even a full-juz wird
// (up to 20 pages) stays compact. Pure UI: the page numbers are passed in.

/** Build the page-tafseer keyboard for the given wird pages (in reading order).
 *  `perRow` keeps wide wirds tidy. */
export function buildPageTafseerKeyboard(pages: number[], perRow = 4): InlineKeyboard {
  const kb = new InlineKeyboard();
  pages.forEach((page, i) => {
    kb.url(`📖 ${toArabicDigits(page)}`, pageTafseerUrl(page));
    // Break to a new row after every `perRow` buttons, but never after the last
    // one (a trailing .row() would leave an empty row).
    if ((i + 1) % perRow === 0 && i < pages.length - 1) kb.row();
  });
  return kb;
}
