import { describe, it, expect } from 'vitest';
import { buildRiwayahKeyboard, RIWAYAH_PICK_PREFIX } from './riwayah-keyboard';

function buttons(kb: ReturnType<typeof buildRiwayahKeyboard>) {
  return kb.inline_keyboard.flat();
}

describe('buildRiwayahKeyboard', () => {
  it('offers one button per offered riwayah, checking the current one', () => {
    const kb = buildRiwayahKeyboard(['hafs', 'warsh-asbahani'], 'hafs');
    const all = buttons(kb);
    expect(all).toHaveLength(2);
    const hafs = all.find(
      (b) => 'callback_data' in b && b.callback_data === `${RIWAYAH_PICK_PREFIX}hafs`,
    )!;
    const warsh = all.find(
      (b) => 'callback_data' in b && b.callback_data === `${RIWAYAH_PICK_PREFIX}warsh-asbahani`,
    )!;
    expect(hafs.text).toContain('✅'); // the current one
    expect(warsh.text).not.toContain('✅');
    expect(warsh.text).toContain('ورش'); // labelled with its name
  });

  it('marks Warsh as current when selected', () => {
    const all = buttons(buildRiwayahKeyboard(['hafs', 'warsh-asbahani'], 'warsh-asbahani'));
    const warsh = all.find(
      (b) => 'callback_data' in b && b.callback_data === `${RIWAYAH_PICK_PREFIX}warsh-asbahani`,
    )!;
    expect(warsh.text).toContain('✅');
  });
});
