// Pure helpers for the optional "image" delivery format: a subscriber can
// receive each daily page as a picture of the actual Madani Mushaf page
// (like the Wahy app shows it) instead of plain text. No database, no network
// here, so it is trivially testable.
//
// We do NOT bundle 604 page images in the repo. Instead an operator points
// MUSHAF_IMAGE_BASE_URL at a VERIFIED source of Madani Mushaf page images (see
// .env.example). Telegram fetches the photo from that URL the first time; we
// then cache the file_id Telegram returns and reuse it forever (see
// MushafPageImage), so every later send is one cheap reference, not an upload.
//
// This file owns only the pure pieces: the format flag and the URL builder.

import { isValidPage } from './wird';

/** The two ways a wird can be delivered. Stored as a short string on the
 *  subscriber row (no Prisma enum), matching the rest of the schema. */
export type WirdFormat = 'text' | 'image';

export const WIRD_FORMAT_TEXT: WirdFormat = 'text';
export const WIRD_FORMAT_IMAGE: WirdFormat = 'image';
export const WIRD_FORMATS: readonly WirdFormat[] = [WIRD_FORMAT_TEXT, WIRD_FORMAT_IMAGE];

/** True when `value` is one of the known formats. */
export function isWirdFormat(value: unknown): value is WirdFormat {
  return value === WIRD_FORMAT_TEXT || value === WIRD_FORMAT_IMAGE;
}

/**
 * Coerce a stored/raw value into a valid format. The fallback is for an
 * unexpected/missing value and is text on purpose: text always renders and
 * needs no image source, so it is the safe last resort. This is NOT the
 * product default for a new subscriber, that lives on the DB column
 * (`wirdFormat`, currently "image"); this only guards a value that is somehow
 * neither "text" nor "image".
 */
export function normalizeWirdFormat(
  raw: unknown,
  fallback: WirdFormat = WIRD_FORMAT_TEXT,
): WirdFormat {
  return isWirdFormat(raw) ? raw : fallback;
}

// The placeholders an operator may use in MUSHAF_IMAGE_BASE_URL:
//   {page}  -> the page number as-is, e.g. 25
//   {page3} -> the page number zero-padded to 3 digits, e.g. 025
// Many image hosts (and the self-host script) name files "001.jpg" ...
// "604.jpg", so {page3} is common.
const PLACEHOLDER = /\{page3?\}/;

/** True when a base template has a usable page placeholder. Used by config to
 *  fail fast on a misconfigured value, and by tests. */
export function hasPagePlaceholder(template: string): boolean {
  return PLACEHOLDER.test(template);
}

/** True when a source string is an http(s) URL (Telegram fetches it) rather
 *  than a local filesystem path (the bot uploads the file itself). */
export function isHttpSource(source: string): boolean {
  return /^https?:\/\//i.test(source);
}

/**
 * Build the image source for one Mushaf page from a template, substituting the
 * page number. The result is either an http(s) URL (Telegram fetches it) or a
 * local filesystem path (the bot uploads it) depending on the template. Throws
 * on an invalid page (1..604) or a template with no placeholder, so a bad value
 * can never produce a wrong or empty source.
 */
export function mushafImageSource(template: string, page: number): string {
  if (!isValidPage(page)) {
    throw new Error(`mushafImageSource: page must be 1..604, got ${page}`);
  }
  if (!hasPagePlaceholder(template)) {
    throw new Error(
      `mushafImageSource: template "${template}" has no {page} (or {page3}) placeholder`,
    );
  }
  return template
    .replace(/\{page3\}/g, String(page).padStart(3, '0'))
    .replace(/\{page\}/g, String(page));
}
