import { InlineKeyboard } from 'grammy';
import { WIRD_FORMAT_TEXT, WIRD_FORMAT_IMAGE, type WirdFormat } from '../core';

// Callback data prefix for the delivery-format picker, e.g. "tilawah:fmt:image".
export const FORMAT_PICK_PREFIX = 'tilawah:fmt:';

// A check mark on the currently selected format, so the user can see which one
// is active at a glance.
function label(text: string, isCurrent: boolean): string {
  return isCurrent ? `✅ ${text}` : text;
}

/**
 * Build the format picker: text vs image. The image button is shown only when
 * a page-image source is configured (`imageAvailable`); otherwise image is not
 * an option on this deployment and offering it would only disappoint.
 */
export function buildFormatKeyboard(current: WirdFormat, imageAvailable: boolean): InlineKeyboard {
  const kb = new InlineKeyboard().text(
    label('نص', current === WIRD_FORMAT_TEXT),
    `${FORMAT_PICK_PREFIX}${WIRD_FORMAT_TEXT}`,
  );
  if (imageAvailable) {
    kb.text(
      label('صورة', current === WIRD_FORMAT_IMAGE),
      `${FORMAT_PICK_PREFIX}${WIRD_FORMAT_IMAGE}`,
    );
  }
  return kb;
}
