import { InlineKeyboard } from 'grammy';
import { COPY } from './copy';
import { LESSONS_OPEN } from './tajweed-lessons-keyboard';

// The on/off button under /tajweed. Tapping it flips the daily lesson for this
// subscriber. Namespaced callback data, like the other pickers.
export const TAJWEED_TOGGLE = 'tilawah:tajweed:toggle';

/** The /tajweed keyboard: the daily-lesson on/off toggle, plus a button to
 *  browse the whole lessons library. Browsing is independent of the on/off
 *  state, so a reader can explore the rules whether or not the daily lesson is
 *  on. */
export function buildTajweedKeyboard(enabled: boolean): InlineKeyboard {
  return new InlineKeyboard()
    .text(enabled ? COPY.tajweedTurnOffBtn : COPY.tajweedTurnOnBtn, TAJWEED_TOGGLE)
    .row()
    .text(COPY.tajweedBrowseBtn, LESSONS_OPEN);
}
