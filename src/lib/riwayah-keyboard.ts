import { InlineKeyboard } from 'grammy';
import { riwayahLabel, type RiwayahKey } from '../core';

// The /riwayah picker: one button per OFFERED riwayah (see offeredRiwayat in
// deliver.ts — a riwayah appears only once its data and assets are ready), a
// check mark on the current one. Namespaced callback data like the other
// pickers so it never clashes.
export const RIWAYAH_PICK_PREFIX = 'tilawah:riwayah:';

/** Build the riwayah picker for the offered riwayat, marking the current one. */
export function buildRiwayahKeyboard(
  offered: readonly RiwayahKey[],
  current: RiwayahKey,
): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const key of offered) {
    const text = key === current ? `✅ ${riwayahLabel(key)}` : riwayahLabel(key);
    kb.text(text, `${RIWAYAH_PICK_PREFIX}${key}`).row();
  }
  return kb;
}
