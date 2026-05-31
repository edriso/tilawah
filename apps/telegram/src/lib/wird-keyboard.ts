import { InlineKeyboard } from 'grammy';
import { toArabicDigits } from '@tilawa/core';

// Callback data prefix for the wird-size picker, e.g. "tilawa:wird:5".
export const WIRD_PICK_PREFIX = 'tilawa:wird:';

// A few common wird sizes. Typing a number stays available via "/wird N", but
// most people tap one of these. The values span the gentle start (1 page),
// the steady habit (2-5), the half-juz (10) and the monthly khatma (20 = a
// juz a day). All are within the 1..20 max.
const PRESET_SIZES = [1, 2, 5, 10, 20];

/** A short Arabic label for a preset, e.g. "صفحة" or "٥ صفحات" or "جزء (٢٠)". */
function presetLabel(pages: number): string {
  if (pages === 1) return 'صفحة';
  if (pages === 20) return 'جزء (٢٠)';
  return `${toArabicDigits(pages)} صفحات`;
}

/** Build the preset wird-size keyboard, three per row. */
export function buildWirdKeyboard(): InlineKeyboard {
  const kb = new InlineKeyboard();
  PRESET_SIZES.forEach((pages, i) => {
    kb.text(presetLabel(pages), `${WIRD_PICK_PREFIX}${pages}`);
    if ((i + 1) % 3 === 0) kb.row();
  });
  return kb;
}
