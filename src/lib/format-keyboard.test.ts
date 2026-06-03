import { describe, it, expect } from 'vitest';
import { buildFormatKeyboard, FORMAT_PICK_PREFIX } from './format-keyboard';

type Btn = { text?: string; callback_data?: string };

describe('buildFormatKeyboard', () => {
  it('offers both text and image when image is available', () => {
    const buttons = buildFormatKeyboard('text', true).inline_keyboard.flat() as Btn[];
    const data = buttons.map((b) => b.callback_data);
    expect(data).toContain(`${FORMAT_PICK_PREFIX}text`);
    expect(data).toContain(`${FORMAT_PICK_PREFIX}image`);
  });

  it('hides the image button when no image source is configured', () => {
    const buttons = buildFormatKeyboard('text', false).inline_keyboard.flat() as Btn[];
    const data = buttons.map((b) => b.callback_data);
    expect(data).toContain(`${FORMAT_PICK_PREFIX}text`);
    expect(data).not.toContain(`${FORMAT_PICK_PREFIX}image`);
  });

  it('marks the current format with a check', () => {
    const buttons = buildFormatKeyboard('image', true).inline_keyboard.flat() as Btn[];
    const image = buttons.find((b) => b.callback_data === `${FORMAT_PICK_PREFIX}image`);
    const text = buttons.find((b) => b.callback_data === `${FORMAT_PICK_PREFIX}text`);
    expect(image?.text).toContain('✅');
    expect(text?.text).not.toContain('✅');
  });
});
