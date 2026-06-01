// Builds the Arabic messages a subscriber receives for their daily wird.
// Pure string work, so it is easy to test.
//
// We send plain text with NO Telegram parse_mode on purpose: Quran text
// contains characters that Markdown/HTML parsing would choke on (the send
// would fail with a 400). Plain text always renders correctly.
//
// A wird is one or more Mushaf pages. We send ONE message per page (each
// labelled with its page and juz), which reads naturally and keeps every
// message far under Telegram's size limit. If a single page ever rendered
// longer than the limit (it never does in the Madani Mushaf, but we are
// careful with the holy text) it is split at surah boundaries.

import type { PageAyah, PageContent } from './types';
import { toArabicDigits } from './arabic';
import { surahUsesBasmala } from './basmala';

/** Telegram's hard limit on message length (characters). */
export const TELEGRAM_MAX = 4096;
// We pack messages up to a slightly smaller size to leave margin for the way
// Telegram counts emoji and any future small wording changes.
const SAFE_LIMIT = 4000;

/** Wrap an ayah number in the ornamented end-of-ayah brackets: ﴿٥﴾. */
export function ayahMarker(numberInSurah: number): string {
  return `﴿${toArabicDigits(numberInSurah)}﴾`;
}

/** Render one ayah: its text followed by its numbered marker. */
export function formatAyahLine(ayah: PageAyah): string {
  return `${ayah.text} ${ayahMarker(ayah.numberInSurah)}`;
}

/**
 * The page banner, e.g. "📖 صفحة ٢٥ • الجزء ٢". A page that straddles a juz
 * boundary (only a handful do, e.g. page 62) names both, e.g. "الجزءان ٣ و٤",
 * so the label is never wrong for the part of the page in the next juz.
 */
function pageHeader(page: PageContent): string {
  const juzEnd = page.juzEnd ?? page.juz;
  const juzLabel =
    juzEnd > page.juz
      ? `الجزءان ${toArabicDigits(page.juz)} و${toArabicDigits(juzEnd)}`
      : `الجزء ${toArabicDigits(page.juz)}`;
  return `📖 صفحة ${toArabicDigits(page.pageNumber)} • ${juzLabel}`;
}

// A run of consecutive ayat on a page that belong to the same surah.
interface SurahSection {
  surahNumber: number;
  surahNameAr: string;
  /** True when this section begins at ayah 1 (a real surah opening). */
  startsAtSurah: boolean;
  ayat: PageAyah[];
}

/** Split a page's ayat into consecutive same-surah sections. */
function sectionsOf(page: PageContent): SurahSection[] {
  const sections: SurahSection[] = [];
  for (const ayah of page.ayat) {
    const last = sections[sections.length - 1];
    if (!last || last.surahNumber !== ayah.surahNumber) {
      sections.push({
        surahNumber: ayah.surahNumber,
        surahNameAr: ayah.surahNameAr,
        startsAtSurah: ayah.numberInSurah === 1,
        ayat: [ayah],
      });
    } else {
      last.ayat.push(ayah);
    }
  }
  return sections;
}

/**
 * Render one surah section into a text block: a "سورة X" header, the basmala
 * when the section opens a surah that carries one, then the ayat as flowing
 * text with their markers. The basmala bytes are passed in (from the seeded
 * text) so what we show can never drift from the verified source.
 */
function renderSection(section: SurahSection, basmala: string): string {
  const lines = [`سورة ${section.surahNameAr}`];
  if (section.startsAtSurah && surahUsesBasmala(section.surahNumber)) {
    lines.push(basmala);
  }
  lines.push(section.ayat.map(formatAyahLine).join(' '));
  return lines.join('\n');
}

/**
 * Render a single page into one message, or several if it somehow exceeds the
 * size limit. A real Madani Mushaf page never gets close (the longest is well
 * under half the limit), but we never truncate the holy text, so the fallback
 * splits at AYAH boundaries and guarantees every message fits.
 */
export function formatPage(page: PageContent, basmala: string): string[] {
  const header = pageHeader(page);
  const whole = [header, ...sectionsOf(page).map((s) => renderSection(s, basmala))].join('\n\n');
  if (whole.length <= SAFE_LIMIT) return [whole];
  return chunkPage(page, basmala, header);
}

/**
 * Split an oversized page into messages, each within the limit, breaking only
 * at ayah boundaries so an ayah is never cut in half. Every unit emitted (the
 * header, a "سورة X" line, the basmala, a single ayah) is far shorter than the
 * limit, so a unit always fits; when a surah's ayat spill into the next message
 * its name is repeated. The common single-message path above never reaches
 * here, so this only governs the (currently hypothetical) giant page.
 */
function chunkPage(page: PageContent, basmala: string, header: string): string[] {
  const messages: string[] = [];
  let head = header;
  let lines: string[] = [];

  const lengthWith = (line: string): number => `${head}\n\n${[...lines, line].join('\n')}`.length;
  const flush = () => {
    messages.push(`${head}\n\n${lines.join('\n')}`);
    head = `${header} (تابع)`;
    lines = [];
  };
  // Add a line, starting a new message first if it would not otherwise fit.
  const add = (line: string) => {
    if (lines.length > 0 && lengthWith(line) > SAFE_LIMIT) flush();
    lines.push(line);
  };

  for (const section of sectionsOf(page)) {
    const title = `سورة ${section.surahNameAr}`;
    add(title);
    if (section.startsAtSurah && surahUsesBasmala(section.surahNumber)) add(basmala);
    for (const ayah of section.ayat) {
      const line = formatAyahLine(ayah);
      // If this ayah forces a new message, repeat the surah name there first.
      if (lines.length > 0 && lengthWith(line) > SAFE_LIMIT) {
        flush();
        lines.push(`${title} (تابع)`);
      }
      lines.push(line);
    }
  }
  flush();
  return messages;
}

/**
 * Build all the messages for a wird (one or more pages), in reading order.
 * `lead` is an optional first line (e.g. "🌿 وردك اليوم") prepended to the
 * very first message so the app can label the wird without an extra message.
 */
export function formatWird(pages: PageContent[], basmala: string, lead?: string): string[] {
  const messages: string[] = [];
  pages.forEach((page, index) => {
    const pageMessages = formatPage(page, basmala);
    if (index === 0 && lead) pageMessages[0] = `${lead}\n\n${pageMessages[0]}`;
    messages.push(...pageMessages);
  });
  return messages;
}
