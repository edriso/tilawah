// The reciters offered for the daily page recitation, and the URL builder for a
// page's audio. Pure: no database, no network. The actual audio is fetched from
// everyayah.com (a trusted, no-copyright recitation host) at send time and then
// cached by Telegram file_id (see PageAudio), exactly like the Mushaf images.

import { isValidPage } from './wird';

/** The reciter keys the bot offers. Stored as a short string on the subscriber
 *  (no Prisma enum), matching the rest of the schema. */
export type ReciterKey = 'abdulbasit' | 'husary' | 'alafasy' | 'sudais' | 'minshawi';

// Each key maps to its everyayah.com data folder (verified to have a per-page
// PageMp3s set). Bitrate chosen per reciter for a good size/quality balance
// (only 64/192 exist for some, 128 for others).
export const RECITERS: Record<ReciterKey, { folder: string }> = {
  abdulbasit: { folder: 'Abdul_Basit_Murattal_192kbps' },
  husary: { folder: 'Husary_128kbps' },
  alafasy: { folder: 'Alafasy_128kbps' },
  sudais: { folder: 'Abdurrahmaan_As-Sudais_192kbps' },
  minshawi: { folder: 'Minshawy_Murattal_128kbps' },
};

/** The reciter keys in display order (default first). */
export const RECITER_KEYS = Object.keys(RECITERS) as ReciterKey[];

/** The product default for a new subscriber and the channel. */
export const DEFAULT_RECITER: ReciterKey = 'abdulbasit';

/** True when `value` is a known reciter key. */
export function isReciter(value: unknown): value is ReciterKey {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(RECITERS, value);
}

/** Coerce a stored/raw value into a valid reciter key, defaulting safely. */
export function normalizeReciter(raw: unknown): ReciterKey {
  return isReciter(raw) ? raw : DEFAULT_RECITER;
}

// The everyayah per-page template. {folder} is the reciter's data folder,
// {page3} the page zero-padded to 3 digits (1..604 -> 001..604).
export const PAGE_AUDIO_TEMPLATE = 'https://everyayah.com/data/{folder}/PageMp3s/Page{page3}.mp3';

/**
 * Build the audio URL for one Mushaf page in a reciter's voice. Throws on an
 * invalid page (1..604) so a bad value can never form a wrong/empty source.
 * `template` is overridable for a future self-hosted set; it defaults to
 * everyayah.
 */
export function pageAudioSource(
  reciter: ReciterKey,
  page: number,
  template: string = PAGE_AUDIO_TEMPLATE,
): string {
  if (!isValidPage(page)) {
    throw new Error(`pageAudioSource: page must be 1..604, got ${page}`);
  }
  return template
    .replace(/\{folder\}/g, RECITERS[reciter].folder)
    .replace(/\{page3\}/g, String(page).padStart(3, '0'))
    .replace(/\{page\}/g, String(page));
}
