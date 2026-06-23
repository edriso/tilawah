import { describe, it, expect } from 'vitest';
import { buildReciterKeyboard, RECITER_OFF, RECITER_PICK_PREFIX } from './reciter-keyboard';
import { recitersForRiwayah } from '../core';

// The picker is built per riwayah; these tests use the Hafs reciters.
const HAFS = recitersForRiwayah('hafs');

// Flatten the keyboard to its buttons for assertions.
function buttons(kb: ReturnType<typeof buildReciterKeyboard>) {
  return kb.inline_keyboard.flat();
}

describe('buildReciterKeyboard', () => {
  it('offers off + every reciter of the riwayah, off checked when disabled', () => {
    const kb = buildReciterKeyboard(false, 'abdulbasit', HAFS);
    const all = buttons(kb);
    // off + one per reciter.
    expect(all).toHaveLength(HAFS.length + 1);
    // It shows only the riwayah's reciters (no Warsh voice among the Hafs list).
    expect(HAFS).not.toContain('abdulkarim');
    const off = all.find((b) => 'callback_data' in b && b.callback_data === RECITER_OFF)!;
    expect(off.text).toContain('✅'); // off is the active state
    // No reciter is checked while disabled. (Exclude the off button, whose
    // callback also starts with the reciter prefix.)
    const reciterBtns = all.filter(
      (b) =>
        'callback_data' in b &&
        b.callback_data!.startsWith(RECITER_PICK_PREFIX) &&
        b.callback_data !== RECITER_OFF,
    );
    expect(reciterBtns).toHaveLength(HAFS.length);
    expect(reciterBtns.every((b) => !b.text.includes('✅'))).toBe(true);
  });

  it('checks the current reciter when enabled, and not off', () => {
    const kb = buildReciterKeyboard(true, 'husary', HAFS);
    const all = buttons(kb);
    const off = all.find((b) => 'callback_data' in b && b.callback_data === RECITER_OFF)!;
    expect(off.text).not.toContain('✅');
    const husary = all.find(
      (b) => 'callback_data' in b && b.callback_data === `${RECITER_PICK_PREFIX}husary`,
    )!;
    expect(husary.text).toContain('✅');
  });
});
