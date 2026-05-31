// Download the verified Quran data, check it hard, and write it to a frozen
// JSON file the seed reads. Run once with: pnpm data:fetch
//
// We fetch two things from trusted sources and join them by (surah, ayah):
//
//   1. The Uthmani TEXT, from the Tanzil project (https://tanzil.net). This is
//      the manually verified text used by major Quran apps. We verify it
//      against an independent count table (6236 ayat, exact count per surah).
//
//   2. The PAGE and JUZ boundaries of the standard Madani Mushaf (604 pages,
//      30 juz), from the Al Quran Cloud metadata API. We verify the counts and
//      well-known anchors (page 1 is Al-Fatihah, page 2 is Al-Baqarah, page
//      604 is An-Nas, juz 30 is An-Naba').
//
// Both are downloaded ONCE and frozen to disk, so a daily send never depends
// on the network, and nothing reaches a reader unless every check passed.
//
// We never hand-type a single ayah, page number, or juz number. They all come
// from these sources and are verified before anything is written.

import { createHash } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { surahUsesBasmala, removeBasmalaPrefix, loadEnv } from '../src/core';
import { AYAH_COUNTS, TOTAL_AYAT } from '../src/database/reference/ayah-counts';
import { PAGE_COUNT, JUZ_COUNT, PAGE_ANCHORS, JUZ_ANCHORS } from '../src/database/reference/pages';

// Pick up override URLs from the root .env if present.
loadEnv();

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(HERE, '..', 'prisma', 'data');
const OUT_JSON = join(DATA_DIR, 'quran-uthmani.json');

// Tanzil "Uthmani" text, output type "Text (with aya numbers)". Lines look
// like:  1|1|بِسْمِ ٱللَّهِ ...   (sura|aya|text). Override with QURAN_SOURCE_URL.
const DEFAULT_TEXT_URL =
  'https://tanzil.net/pub/download/index.php?quranType=uthmani&outType=txt-2&agree=true';

// Al Quran Cloud metadata: page and juz boundary references for the Madani
// Mushaf. Override with QURAN_META_URL.
const DEFAULT_META_URL = 'https://api.alquran.cloud/v1/meta';

interface ParsedAyah {
  surah: number;
  ayah: number;
  text: string;
  page: number;
  juz: number;
}

/** A boundary reference: the (surah, ayah) that starts a page or a juz. */
interface BoundaryRef {
  surah: number;
  ayah: number;
}

async function main() {
  const textUrl = process.env.QURAN_SOURCE_URL?.trim() || DEFAULT_TEXT_URL;
  const metaUrl = process.env.QURAN_META_URL?.trim() || DEFAULT_META_URL;

  console.log(`Downloading Quran text from:\n  ${textUrl}\n`);
  const rawText = await download(textUrl);
  const ayat = parseText(rawText);
  verifyText(ayat);

  console.log(`Downloading page and juz boundaries from:\n  ${metaUrl}\n`);
  const { pages, juzs } = await downloadMeta(metaUrl);
  verifyBoundaries(pages, juzs);

  // Join: stamp each ayah with its page and juz from the boundaries.
  assignPagesAndJuz(ayat, pages, juzs);
  verifyAssignment(ayat);

  const basmala = normalizeBasmala(ayat);

  const surahs = groupBySurah(ayat);
  const textForHash = ayat.map((a) => a.text).join('\n');
  const sha256 = createHash('sha256').update(textForHash, 'utf8').digest('hex');

  const payload = {
    meta: {
      textSource: 'Tanzil Uthmani (https://tanzil.net)',
      textUrl,
      metaSource: 'Al Quran Cloud metadata (https://alquran.cloud)',
      metaUrl,
      totalAyat: ayat.length,
      totalPages: PAGE_COUNT,
      totalJuz: JUZ_COUNT,
      // The basmala kept verbatim from the source (surah 1 ayah 1), shown as
      // the surah opening at display time.
      basmala,
      sha256,
    },
    surahs,
  };

  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(OUT_JSON, JSON.stringify(payload, null, 2) + '\n', 'utf8');

  console.log(`Verified ${ayat.length} ayat, ${PAGE_COUNT} pages, ${JUZ_COUNT} juz.`);
  console.log(`SHA-256 (text): ${sha256}`);
  console.log(`Wrote ${OUT_JSON}`);
  console.log('\nNext: pnpm db:seed');
}

async function download(url: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(url, { headers: { 'User-Agent': 'tilawa-bot/1.0 (+quran data fetch)' } });
  } catch (err) {
    throw new Error(`Could not reach ${url}. Check your connection.\n  ${String(err)}`);
  }
  if (!res.ok) throw new Error(`Download failed with HTTP ${res.status} for ${url}.`);
  return res.text();
}

/** Parse "sura|aya|text" lines, skipping blank lines and # comments. */
function parseText(raw: string): ParsedAyah[] {
  const out: ParsedAyah[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const parts = line.split('|');
    if (parts.length < 3) continue;
    const surah = Number(parts[0]);
    const ayah = Number(parts[1]);
    const text = parts.slice(2).join('|').trim();
    if (!Number.isInteger(surah) || !Number.isInteger(ayah) || text === '') continue;
    // page and juz are filled in later from the boundaries.
    out.push({ surah, ayah, text, page: 0, juz: 0 });
  }
  return out;
}

/** Pull the page and juz boundary reference lists out of the meta response. */
async function downloadMeta(url: string): Promise<{ pages: BoundaryRef[]; juzs: BoundaryRef[] }> {
  const raw = await download(url);
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Meta response was not valid JSON.\n  ${String(err)}`);
  }
  const data = (
    json as { data?: { pages?: { references?: unknown }; juzs?: { references?: unknown } } }
  ).data;
  const pages = data?.pages?.references;
  const juzs = data?.juzs?.references;
  if (!Array.isArray(pages) || !Array.isArray(juzs)) {
    throw new Error('Meta response is missing data.pages.references or data.juzs.references.');
  }
  return { pages: pages.map(toBoundary), juzs: juzs.map(toBoundary) };
}

function toBoundary(value: unknown): BoundaryRef {
  const v = value as { surah?: unknown; ayah?: unknown };
  const surah = Number(v.surah);
  const ayah = Number(v.ayah);
  if (!Number.isInteger(surah) || !Number.isInteger(ayah)) {
    throw new Error(`Bad boundary reference: ${JSON.stringify(value)}`);
  }
  return { surah, ayah };
}

/**
 * Fail loudly unless the parsed text matches the canonical structure: 6236
 * ayat total, surahs 1..114, and each surah's ayat numbered 1..count with the
 * exact count from the oracle table.
 */
function verifyText(ayat: ParsedAyah[]): void {
  if (ayat.length !== TOTAL_AYAT) {
    throw new Error(`Expected ${TOTAL_AYAT} ayat but parsed ${ayat.length}. Download incomplete.`);
  }
  const perSurah = new Map<number, number[]>();
  for (const a of ayat) {
    if (!perSurah.has(a.surah)) perSurah.set(a.surah, []);
    perSurah.get(a.surah)!.push(a.ayah);
  }
  if (perSurah.size !== 114) throw new Error(`Expected 114 surahs but found ${perSurah.size}.`);
  for (let surah = 1; surah <= 114; surah++) {
    const ayahs = perSurah.get(surah);
    const expected = AYAH_COUNTS[surah];
    if (!ayahs) throw new Error(`Surah ${surah} is missing from the download.`);
    if (ayahs.length !== expected) {
      throw new Error(`Surah ${surah} has ${ayahs.length} ayat but should have ${expected}.`);
    }
    for (let i = 0; i < expected; i++) {
      if (ayahs[i] !== i + 1) {
        throw new Error(`Surah ${surah} ayah numbering is off at position ${i + 1}.`);
      }
    }
  }
}

/**
 * Fail loudly unless the boundaries describe the standard Madani Mushaf: 604
 * pages, 30 juz, strictly increasing (surah, ayah) starts, and the well-known
 * anchors in the right place.
 */
function verifyBoundaries(pages: BoundaryRef[], juzs: BoundaryRef[]): void {
  if (pages.length !== PAGE_COUNT) {
    throw new Error(`Expected ${PAGE_COUNT} page boundaries but got ${pages.length}.`);
  }
  if (juzs.length !== JUZ_COUNT) {
    throw new Error(`Expected ${JUZ_COUNT} juz boundaries but got ${juzs.length}.`);
  }
  assertStrictlyIncreasing(pages, 'page');
  assertStrictlyIncreasing(juzs, 'juz');

  for (const a of PAGE_ANCHORS) {
    const ref = pages[a.page - 1];
    if (ref.surah !== a.surah || ref.ayah !== a.ayah) {
      throw new Error(
        `Page ${a.page} should start at ${a.surah}:${a.ayah} but got ${ref.surah}:${ref.ayah}. ` +
          `This is not the standard Madani layout.`,
      );
    }
  }
  for (const a of JUZ_ANCHORS) {
    const ref = juzs[a.juz - 1];
    if (ref.surah !== a.surah || ref.ayah !== a.ayah) {
      throw new Error(
        `Juz ${a.juz} should start at ${a.surah}:${a.ayah} but got ${ref.surah}:${ref.ayah}.`,
      );
    }
  }
  // The last anchor checks page 604 starts correctly; also confirm the very
  // last ayah of the Quran lands on page 604 (done in verifyAssignment).
}

/** A (surah, ayah) sort key, surah-major. */
function key(surah: number, ayah: number): number {
  return surah * 1000 + ayah; // ayah counts are well under 1000
}

function assertStrictlyIncreasing(refs: BoundaryRef[], label: string): void {
  for (let i = 1; i < refs.length; i++) {
    if (key(refs[i].surah, refs[i].ayah) <= key(refs[i - 1].surah, refs[i - 1].ayah)) {
      throw new Error(`${label} boundaries are not strictly increasing at index ${i}.`);
    }
  }
}

/**
 * Stamp every ayah with its page and juz. We walk the ayat in canonical order
 * and a pointer along each boundary list, advancing the pointer when the next
 * boundary's start is reached. Because the source orders ayat as the Mushaf
 * does, this assigns each ayah the page/juz it physically sits on.
 */
function assignPagesAndJuz(ayat: ParsedAyah[], pages: BoundaryRef[], juzs: BoundaryRef[]): void {
  const sorted = [...ayat].sort((a, b) => key(a.surah, a.ayah) - key(b.surah, b.ayah));
  let pageIdx = 0;
  let juzIdx = 0;
  for (const a of sorted) {
    const k = key(a.surah, a.ayah);
    while (
      pageIdx + 1 < pages.length &&
      key(pages[pageIdx + 1].surah, pages[pageIdx + 1].ayah) <= k
    ) {
      pageIdx++;
    }
    while (juzIdx + 1 < juzs.length && key(juzs[juzIdx + 1].surah, juzs[juzIdx + 1].ayah) <= k) {
      juzIdx++;
    }
    a.page = pageIdx + 1; // boundaries are 0-based; pages/juz are 1-based
    a.juz = juzIdx + 1;
  }
}

/** Final sanity pass over the stamped ayat. */
function verifyAssignment(ayat: ParsedAyah[]): void {
  let maxPage = 0;
  let maxJuz = 0;
  for (const a of ayat) {
    if (a.page < 1 || a.page > PAGE_COUNT)
      throw new Error(`Ayah ${a.surah}:${a.ayah} got page ${a.page}.`);
    if (a.juz < 1 || a.juz > JUZ_COUNT)
      throw new Error(`Ayah ${a.surah}:${a.ayah} got juz ${a.juz}.`);
    maxPage = Math.max(maxPage, a.page);
    maxJuz = Math.max(maxJuz, a.juz);
  }
  if (maxPage !== PAGE_COUNT)
    throw new Error(`Highest page is ${maxPage}, expected ${PAGE_COUNT}.`);
  if (maxJuz !== JUZ_COUNT) throw new Error(`Highest juz is ${maxJuz}, expected ${JUZ_COUNT}.`);

  // Anchor: the last ayah of the Quran (An-Nas 114:6) must be on page 604.
  const last = ayat.find((a) => a.surah === 114 && a.ayah === 6);
  if (!last || last.page !== PAGE_COUNT) {
    throw new Error(`An-Nas 114:6 should be on page ${PAGE_COUNT} but is on ${last?.page}.`);
  }
  // Anchor: Al-Fatihah is wholly on page 1, Al-Baqarah opens on page 2.
  const fatihaLast = ayat.find((a) => a.surah === 1 && a.ayah === 7);
  const baqaraFirst = ayat.find((a) => a.surah === 2 && a.ayah === 1);
  if (fatihaLast?.page !== 1) throw new Error(`Al-Fatihah 1:7 should be on page 1.`);
  if (baqaraFirst?.page !== 2) throw new Error(`Al-Baqarah 2:1 should be on page 2.`);
}

/**
 * Separate the basmala from the first ayah of each surah, and return it
 * verbatim. This Tanzil Uthmani edition merges the basmala into ayah 1 of
 * every surah except At-Tawbah (9). We store the pure numbered ayah and show
 * the basmala as the surah opening at display time, so the reader still sees
 * the full basmala in its correct place. Al-Fatihah (1) is left untouched
 * because there the basmala is ayah 1.
 */
function normalizeBasmala(ayat: ParsedAyah[]): string {
  const opening = ayat.find((a) => a.surah === 1 && a.ayah === 1);
  if (!opening) throw new Error('Surah 1 ayah 1 not found; cannot read the basmala.');
  const basmala = opening.text;

  for (const a of ayat) {
    if (a.ayah !== 1 || a.surah === 1) continue;
    if (!surahUsesBasmala(a.surah)) continue; // At-Tawbah has no basmala
    const cleaned = removeBasmalaPrefix(a.text, basmala);
    if (cleaned === a.text) {
      console.warn(`Note: surah ${a.surah} ayah 1 had no merged basmala (already clean).`);
      continue;
    }
    if (cleaned === '')
      throw new Error(`Surah ${a.surah} ayah 1 became empty after removing basmala.`);
    a.text = cleaned;
  }
  return basmala;
}

/** Reshape into [{ number, ayat: [{ text, page, juz }, ...] }] by surah. */
function groupBySurah(ayat: ParsedAyah[]): {
  number: number;
  ayat: { text: string; page: number; juz: number }[];
}[] {
  const surahs: { number: number; ayat: { text: string; page: number; juz: number }[] }[] = [];
  for (let surah = 1; surah <= 114; surah++) {
    const rows = ayat
      .filter((a) => a.surah === surah)
      .sort((a, b) => a.ayah - b.ayah)
      .map((a) => ({ text: a.text, page: a.page, juz: a.juz }));
    surahs.push({ number: surah, ayat: rows });
  }
  return surahs;
}

main().catch((err) => {
  console.error('\nfetch-quran failed:\n', String(err));
  process.exit(1);
});
