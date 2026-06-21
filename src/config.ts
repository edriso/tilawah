import {
  loadEnv,
  hasPagePlaceholder,
  hasAyahPlaceholder,
  hasFolderPlaceholder,
  PAGE_AUDIO_TEMPLATE,
} from './core';

// Load the single root .env before we read any variable.
loadEnv();

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required environment variable: ${key}`);
  return value;
}

/** Parse a comma-separated list of numeric ids into a set of bigints. */
function parseIdSet(raw: string | undefined): Set<bigint> {
  const set = new Set<bigint>();
  if (!raw) return set;
  for (const part of raw.split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    try {
      set.add(BigInt(trimmed));
    } catch {
      throw new Error(`ADMIN_TELEGRAM_IDS has a non-numeric id: "${trimmed}"`);
    }
  }
  return set;
}

function parseTimezone(raw: string | undefined): string {
  const tz = raw?.trim() || 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    throw new Error(
      `TZ_NAME is not a valid IANA timezone (got "${raw}"). Try "Africa/Cairo", "Europe/London", etc.`,
    );
  }
  return tz;
}

/** "false"/"0"/"no"/"off" disable the personal user bot; anything else (and the
 *  empty default) enables it. */
function parseBool(raw: string | undefined, defaultValue: boolean): boolean {
  if (raw === undefined || raw.trim() === '') return defaultValue;
  return !['false', '0', 'no', 'off'].includes(raw.trim().toLowerCase());
}

/** Validate the optional Mushaf image source template. Empty = feature off
 *  (null). It may be an http(s) URL (Telegram fetches it) or a local file path
 *  (the bot uploads it); either way it must carry a {page}/{page3} placeholder,
 *  so we fail fast on a template that could never form a real page source. */
function parseImageBaseUrl(raw: string | undefined): string | null {
  const url = raw?.trim();
  if (!url) return null;
  if (!hasPagePlaceholder(url)) {
    throw new Error(
      `MUSHAF_IMAGE_BASE_URL must contain a {page} or {page3} placeholder (got "${url}"). ` +
        `Example: https://your-host.example/mushaf/{page3}.png or /app/assets/mushaf/{page3}.jpg`,
    );
  }
  return url;
}

/** Validate the optional tajweed example-audio source template. Empty = no
 *  audio (lessons go out as text). Like the image source it may be an http(s)
 *  URL or a local path, and must carry {surah}/{ayah} (or {surah3}/{ayah3})
 *  placeholders so it can form a real per-ayah source. */
function parseAudioBaseUrl(raw: string | undefined): string | null {
  const url = raw?.trim();
  if (!url) return null;
  if (!hasAyahPlaceholder(url)) {
    throw new Error(
      `TAJWEED_AUDIO_BASE_URL must contain {surah}/{ayah} (or {surah3}/{ayah3}) placeholders ` +
        `(got "${url}"). Example: https://your-host.example/tajweed/{surah3}{ayah3}.mp3`,
    );
  }
  return url;
}

/** The per-page recitation source template. Empty = the everyayah default
 *  (PAGE_AUDIO_TEMPLATE), which works on a dev box but is NOT ayah-verified
 *  (some pages are defective). Production points this at the self-hosted set, an
 *  http(s) URL or a local path; either way it must carry a {folder} and a
 *  {page}/{page3} placeholder, so we fail fast on a template that could never
 *  form a real source. See scripts/build-page-audio.ts and .env.example. */
function parsePageAudioBaseUrl(raw: string | undefined): string {
  const url = raw?.trim();
  if (!url) return PAGE_AUDIO_TEMPLATE;
  if (!hasFolderPlaceholder(url) || !hasPagePlaceholder(url)) {
    throw new Error(
      `PAGE_AUDIO_BASE_URL must contain a {folder} and a {page}/{page3} placeholder (got "${url}"). ` +
        `Example: /app/assets/page-audio/{folder}/Page{page3}.mp3`,
    );
  }
  return url;
}

export const config = Object.freeze({
  // REQUIRED. Bot token from @BotFather.
  botToken: requireEnv('BOT_TOKEN').trim(),
  // Default timezone for brand-new subscribers and the channel.
  defaultTimezone: parseTimezone(process.env.TZ_NAME),
  // The channel to post the wird to, as given in .env (numeric id or
  // @username). Resolved to a numeric chat id at startup. Null = no channel.
  channelChatIdRaw: process.env.CHANNEL_CHAT_ID?.trim() || null,
  // Telegram user ids allowed to run /admin_* commands (private chat only).
  adminIds: parseIdSet(process.env.ADMIN_TELEGRAM_IDS),
  // Whether the personal user bot serves individual users. Off = channel-only.
  userWirdEnabled: parseBool(process.env.USER_WIRD_ENABLED, true),
  // Template URL for Madani Mushaf page images, or null when the image
  // delivery format is not configured. See parseImageBaseUrl and .env.example.
  mushafImageBaseUrl: parseImageBaseUrl(process.env.MUSHAF_IMAGE_BASE_URL),
  // Template for per-ayah tajweed example audio, or null when not configured
  // (lessons then go out without an audio clip). See parseAudioBaseUrl.
  tajweedAudioBaseUrl: parseAudioBaseUrl(process.env.TAJWEED_AUDIO_BASE_URL),
  // Template for the per-page recitation source. Defaults to everyayah; set to
  // the self-hosted verified set in production. See parsePageAudioBaseUrl.
  pageAudioBaseUrl: parsePageAudioBaseUrl(process.env.PAGE_AUDIO_BASE_URL),
  isDev: process.env.NODE_ENV !== 'production',
});

/** True when at least one channel chat is configured. */
export function channelEnabled(): boolean {
  return config.channelChatIdRaw !== null;
}

/** True when the image delivery format can be served (a page-image source is
 *  configured). When false, /format offers text only and any image-format
 *  subscriber falls back to text. */
export function imageWirdAvailable(): boolean {
  return config.mushafImageBaseUrl !== null;
}
