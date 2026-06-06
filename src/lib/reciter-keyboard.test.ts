import { describe, it, expect } from 'vitest';
import { buildReciterKeyboard, RECITER_OFF, RECITER_PICK_PREFIX } from './reciter-keyboard';
import { RECITER_KEYS } from '../core';

// Flatten the keyboard to its buttons for assertions.
function buttons(kb: ReturnType<typeof buildReciterKeyboard>) {
  return kb.inline_keyboard.flat();
}

describe('buildReciterKeyboard', () => {
  it('offers off + every reciter, with the off button checked when disabled', () => {
    const kb = buildReciterKeyboard(false, 'abdulbasit');
    const all = buttons(kb);
    // off + one per reciter.
    expect(all).toHaveLength(RECITER_KEYS.length + 1);
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
    expect(reciterBtns).toHaveLength(RECITER_KEYS.length);
    expect(reciterBtns.every((b) => !b.text.includes('✅'))).toBe(true);
  });

  it('checks the current reciter when enabled, and not off', () => {
    const kb = buildReciterKeyboard(true, 'husary');
    const all = buttons(kb);
    const off = all.find((b) => 'callback_data' in b && b.callback_data === RECITER_OFF)!;
    expect(off.text).not.toContain('✅');
    const husary = all.find(
      (b) => 'callback_data' in b && b.callback_data === `${RECITER_PICK_PREFIX}husary`,
    )!;
    expect(husary.text).toContain('✅');
  });
});
