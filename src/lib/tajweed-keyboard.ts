import { InlineKeyboard } from 'grammy';
import { COPY } from './copy';

// The single on/off button under /tajweed. Tapping it flips the daily lesson
// for this subscriber. Namespaced callback data, like the other pickers.
export const TAJWEED_TOGGLE = 'tilawah:tajweed:toggle';

/** A one-button keyboard: turn the daily lesson off (when on) or on (when off). */
export function buildTajweedKeyboard(enabled: boolean): InlineKeyboard {
  return new InlineKeyboard().text(
    enabled ? COPY.tajweedTurnOffBtn : COPY.tajweedTurnOnBtn,
    TAJWEED_TOGGLE,
  );
}
