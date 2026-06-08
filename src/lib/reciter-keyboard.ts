import { InlineKeyboard } from 'grammy';
import { RECITER_KEYS, type ReciterKey } from '../core';
import { reciterNameAr } from './copy';

// The /reciter picker: one button per reciter then "off" at the bottom, a check
// mark on the current choice. Namespaced callback data like the other pickers.
// The "off" button sits LAST (after the reciters), matching the ayah bot's
// picker, so the two bots feel the same.
export const RECITER_PICK_PREFIX = 'tilawah:reciter:';
export const RECITER_OFF = 'tilawah:reciter:off';

function label(text: string, isCurrent: boolean): string {
  return isCurrent ? `✅ ${text}` : text;
}

/**
 * Build the reciter picker. `enabled` is whether page audio is on, and
 * `current` the chosen reciter; the check mark shows the active reciter, or
 * "off" when disabled.
 */
export function buildReciterKeyboard(enabled: boolean, current: ReciterKey): InlineKeyboard {
  const kb = new InlineKeyboard();
  RECITER_KEYS.forEach((key) => {
    kb.text(
      label(reciterNameAr(key), enabled && key === current),
      `${RECITER_PICK_PREFIX}${key}`,
    ).row();
  });
  kb.text(label('🔇 إيقاف التلاوة', !enabled), RECITER_OFF);
  return kb;
}
