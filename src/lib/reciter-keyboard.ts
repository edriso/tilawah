import { InlineKeyboard } from 'grammy';
import { RECITER_KEYS, type ReciterKey } from '../core';
import { reciterNameAr } from './copy';

// The /reciter picker: "off" plus one button per reciter, a check mark on the
// current choice. Namespaced callback data like the other pickers.
export const RECITER_PICK_PREFIX = 'tilawah:reciter:';
export const RECITER_OFF = 'tilawah:reciter:off';

function label(text: string, isCurrent: boolean): string {
  return isCurrent ? `✅ ${text}` : text;
}

/**
 * Build the reciter picker. `enabled` is whether page audio is on, and
 * `current` the chosen reciter; the check mark shows "off" when disabled, else
 * the active reciter.
 */
export function buildReciterKeyboard(enabled: boolean, current: ReciterKey): InlineKeyboard {
  const kb = new InlineKeyboard().text(label('🔇 إيقاف التلاوة', !enabled), RECITER_OFF).row();
  RECITER_KEYS.forEach((key) => {
    kb.text(
      label(reciterNameAr(key), enabled && key === current),
      `${RECITER_PICK_PREFIX}${key}`,
    ).row();
  });
  return kb;
}
