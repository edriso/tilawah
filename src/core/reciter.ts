// The reciters offered for the daily page recitation, and the URL builder for a
// page's audio. Pure: no database, no network. The actual audio is fetched from
// everyayah.com (a trusted, no-copyright recitation host) at send time and then
// cached by Telegram file_id (see PageAudio), exactly like the Mushaf images.

import { isValidPage } from './wird';
import { hasPagePlaceholder } from './mushaf-image';

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

// The DEFAULT per-page template: everyayah's pre-split PageMp3s. {folder} is the
// reciter's data folder, {page3} the page zero-padded to 3 digits (001..604).
//
// IMPORTANT: everyayah's PageMp3s were auto-split (Mp3Splt) and are NOT
// ayah-verified. Some pages are defective (e.g. Abdul Basit's Page011 drops
// 2:76), and all carry junk ID3 tags with no cover art. For production we build
// a VERIFIED self-hosted set (one clip per page, concatenated from the trusted
// per-ayah files for exactly OUR Madani page map, with clean tags + a cover) and
// point PAGE_AUDIO_BASE_URL at it. See scripts/build-page-audio.ts and
// scripts/verify-audio.ts. This default keeps a dev box working without the set.
export const PAGE_AUDIO_TEMPLATE = 'https://everyayah.com/data/{folder}/PageMp3s/Page{page3}.mp3';

// The trusted per-AYAH source (everyayah, ayah-accurate): {surah3}{ayah3} is the
// 3+3-digit key, e.g. 002076.mp3. The generator concatenates these for a page.
export const PER_AYAH_AUDIO_TEMPLATE = 'https://everyayah.com/data/{folder}/{surah3}{ayah3}.mp3';

/** True when a template carries the reciter {folder} placeholder. */
export function hasFolderPlaceholder(template: string): boolean {
  return /\{folder\}/.test(template);
}

/**
 * Build the audio source for one Mushaf page in a reciter's voice. The result is
 * an http(s) URL (Telegram fetches it) or a local filesystem path (the bot
 * uploads it via InputFile), depending on the template. Throws on an invalid
 * page (1..604) or a template missing the {folder}/{page} placeholders, so a bad
 * value can never form a wrong/empty source. `template` defaults to everyayah;
 * production passes the self-hosted set's path (config.pageAudioBaseUrl).
 */
export function pageAudioSource(
  reciter: ReciterKey,
  page: number,
  template: string = PAGE_AUDIO_TEMPLATE,
): string {
  if (!isValidPage(page)) {
    throw new Error(`pageAudioSource: page must be 1..604, got ${page}`);
  }
  if (!hasFolderPlaceholder(template) || !hasPagePlaceholder(template)) {
    throw new Error(
      `pageAudioSource: template "${template}" needs a {folder} and a {page}/{page3} placeholder`,
    );
  }
  return template
    .replace(/\{folder\}/g, RECITERS[reciter].folder)
    .replace(/\{page3\}/g, String(page).padStart(3, '0'))
    .replace(/\{page\}/g, String(page));
}

/**
 * Build the trusted per-ayah audio URL for (surah, ayah) in a reciter's folder.
 * Used by the page-audio generator to assemble a verified per-page clip; never
 * used at send time (the bot sends whole-page clips).
 */
export function perAyahAudioUrl(
  folder: string,
  surah: number,
  ayah: number,
  template: string = PER_AYAH_AUDIO_TEMPLATE,
): string {
  return template
    .replace(/\{folder\}/g, folder)
    .replace(/\{surah3\}/g, String(surah).padStart(3, '0'))
    .replace(/\{ayah3\}/g, String(ayah).padStart(3, '0'));
}
