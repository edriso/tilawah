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

/** The page banner, e.g. "📖 صفحة ٢٥ • الجزء ٢". */
function pageHeader(page: PageContent): string {
  return `📖 صفحة ${toArabicDigits(page.pageNumber)} • الجزء ${toArabicDigits(page.juz)}`;
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
 * Render a single page into one message, or several messages if it somehow
 * exceeds the size limit (it never does for a real Mushaf page, but we split
 * at surah boundaries as a safety net so a message is never truncated).
 */
export function formatPage(page: PageContent, basmala: string): string[] {
  const header = pageHeader(page);
  const blocks = sectionsOf(page).map((s) => renderSection(s, basmala));

  const whole = [header, ...blocks].join('\n\n');
  if (whole.length <= SAFE_LIMIT) return [whole];

  // Safety net: pack the surah blocks into as few messages as fit, repeating
  // a short continued header. A single block always fits on its own.
  const messages: string[] = [];
  let current = header;
  for (const block of blocks) {
    const trial = `${current}\n\n${block}`;
    if (trial.length > SAFE_LIMIT && current !== header && current !== `${header} (تابع)`) {
      messages.push(current);
      current = `${header} (تابع)\n\n${block}`;
    } else {
      current = trial;
    }
  }
  messages.push(current);
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
