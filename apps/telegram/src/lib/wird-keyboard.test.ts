import { describe, it, expect } from 'vitest';
import { buildWirdKeyboard, WIRD_PICK_PREFIX } from './wird-keyboard';
import { MAX_WIRD_PAGES, MIN_WIRD_PAGES } from '@tilawa/core';

describe('buildWirdKeyboard', () => {
  const buttons = buildWirdKeyboard().inline_keyboard.flat();
  const sizes = buttons.map((b) =>
    Number((b as { callback_data?: string }).callback_data?.slice(WIRD_PICK_PREFIX.length)),
  );

  it('offers several presets, all callback data tilawa:wird:<n>', () => {
    expect(buttons.length).toBeGreaterThan(0);
    for (const b of buttons) {
      const data = (b as { callback_data?: string }).callback_data ?? '';
      expect(data.startsWith(WIRD_PICK_PREFIX)).toBe(true);
    }
  });

  it('keeps every preset inside the allowed 1..20 range', () => {
    for (const n of sizes) {
      expect(Number.isInteger(n)).toBe(true);
      expect(n).toBeGreaterThanOrEqual(MIN_WIRD_PAGES);
      expect(n).toBeLessThanOrEqual(MAX_WIRD_PAGES);
    }
  });

  it('includes the gentle start (1) and the juz-a-day (20)', () => {
    expect(sizes).toContain(1);
    expect(sizes).toContain(20);
  });
});
