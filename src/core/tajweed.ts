// Pure logic for the daily tajweed micro-lesson: the lesson shape, the cycle
// math (which lesson is next, wrapping the deck), and the message formatter.
// No database, no network — the lesson DATA lives in
// src/database/reference/tajweed-lessons.ts and the example ayah TEXT is read
// from the seeded Quran at send time; this file only types and renders.

import { ayahMarker } from './format';

// Unicode directional isolates (First Strong / Pop), used to wrap a trailing
// left-to-right run (a URL) so it never reorders inside right-to-left Arabic.
// core must not import lib/copy's ltr(), so the two code points live here too.
const FSI = String.fromCodePoint(0x2066);
const PDI = String.fromCodePoint(0x2069);

/** One tajweed lesson in the deck. Authored content (reviewed by a qualified
 *  reader), NOT Quran text — the example's ayah text is pulled from the
 *  verified database, never typed here. */
export interface TajweedLesson {
  /** Short Arabic title, e.g. "الإقلاب". */
  titleAr: string;
  /** The lesson body: a few short Arabic lines explaining the rule. */
  bodyAr: string;
  /** A canonical Quran example for the rule: the surah and ayah to quote. */
  example: { surah: number; ayah: number };
  /** Optional one-line pointer to WHERE in the ayah the rule appears. */
  exampleNote?: string;
  /** Optional trusted "learn more" link (a reputable lesson/video). */
  moreUrl?: string;
}

/** The verified example ayah, loaded from the database for a lesson. */
export interface LessonExample {
  surahNameAr: string;
  numberInSurah: number;
  /** The Uthmani text, exactly as seeded. */
  text: string;
}

/**
 * The next lesson index in the deck. 0-based, advancing by one and wrapping
 * back to 0 at the end so the deck repeats forever — the same idea as the wird
 * looping the Mushaf. A null/negative/garbage current restarts at 0.
 */
export function nextLessonIndex(current: number, total: number): number {
  if (!Number.isInteger(total) || total < 1) {
    throw new Error(`nextLessonIndex: total must be >= 1, got ${total}`);
  }
  if (!Number.isInteger(current) || current < 0) return 0;
  return (current + 1) % total;
}

/**
 * Coerce a stored index into a valid 0..total-1 position, so a deck that
 * shrank (lessons removed) or a corrupt value can never read out of range.
 */
export function lessonIndexInRange(index: number, total: number): number {
  if (!Number.isInteger(total) || total < 1) {
    throw new Error(`lessonIndexInRange: total must be >= 1, got ${total}`);
  }
  if (!Number.isInteger(index) || index < 0) return 0;
  return index % total;
}

/**
 * Render the lesson as a plain-text message (no parse_mode, like the wird):
 *
 *   📚 درس التجويد اليوم: <title>
 *   <body>
 *   🎯 مثال: <ayah text> (سورة <name>: آية <n>)
 *   <example note, if any>
 *   🔗 للاستزادة: <url, if any>
 *
 * The audio example, when available, is sent as a separate clip by the caller.
 */
export function formatLesson(lesson: TajweedLesson, example: LessonExample): string {
  const parts = [
    `📚 درس التجويد اليوم: ${lesson.titleAr}`,
    '',
    lesson.bodyAr,
    '',
    // The example reads like the wird: the ayah text with its ornamented number
    // marker, under a label naming its surah. Keeping the reference on the label
    // line (not a parenthetical glued to the verse) avoids any bidi reorder.
    `🎯 مثال من سورة ${example.surahNameAr}:`,
    `${example.text} ${ayahMarker(example.numberInSurah)}`,
  ];
  if (lesson.exampleNote) parts.push(lesson.exampleNote);
  // A trailing left-to-right URL is wrapped in directional isolates so it never
  // reorders after the right-to-left label.
  if (lesson.moreUrl) parts.push(`🔗 للاستزادة: ${FSI}${lesson.moreUrl}${PDI}`);
  return parts.join('\n');
}

// ── Example-audio source ────────────────────────────────────────────
//
// Like mushaf-image.ts, the audio for a lesson's example ayah is NOT bundled.
// An operator points TAJWEED_AUDIO_BASE_URL at a verified per-ayah recitation
// source (e.g. self-hosted Husary clips named 002027.mp3, via the
// data:tajweed script). Telegram fetches/uploads it the first time and we cache
// the file_id (see TajweedAudio). Without a source, lessons go out without audio.
//
// Placeholders in the template:
//   {surah}/{ayah}    -> the numbers as-is
//   {surah3}/{ayah3}  -> zero-padded to 3 digits (everyayah/quran.com style:
//                        002027.mp3 = surah 2, ayah 27)

/** True when a template carries usable surah+ayah placeholders. */
export function hasAyahPlaceholder(template: string): boolean {
  // Needs at least one surah and one ayah placeholder to form a real source.
  return /\{surah3?\}/.test(template) && /\{ayah3?\}/.test(template);
}

/**
 * Build the audio source for one example ayah from a template. Returns an
 * http(s) URL (Telegram fetches it) or a local path (the bot uploads it),
 * mirroring mushafImageSource. Throws on a bad ref or a template with no
 * placeholder, so a misconfigured value can never form a wrong/empty source.
 */
export function tajweedAudioSource(template: string, surah: number, ayah: number): string {
  if (!Number.isInteger(surah) || surah < 1 || surah > 114) {
    throw new Error(`tajweedAudioSource: surah must be 1..114, got ${surah}`);
  }
  if (!Number.isInteger(ayah) || ayah < 1) {
    throw new Error(`tajweedAudioSource: ayah must be >= 1, got ${ayah}`);
  }
  if (!hasAyahPlaceholder(template)) {
    throw new Error(
      `tajweedAudioSource: template "${template}" needs {surah}/{ayah} (or {surah3}/{ayah3}) placeholders`,
    );
  }
  return template
    .replace(/\{surah3\}/g, String(surah).padStart(3, '0'))
    .replace(/\{ayah3\}/g, String(ayah).padStart(3, '0'))
    .replace(/\{surah\}/g, String(surah))
    .replace(/\{ayah\}/g, String(ayah));
}
