// Download the verified Warsh (عن نافع، من طريق الأصبهاني) Quran data, check it
// hard, and write it to a frozen JSON the seed reads. Run with:
//   pnpm data:fetch:warsh
//
// This is the Warsh twin of fetch-quran.ts. The riwayah is a different mushaf
// (different rasm AND a different verse-count school: Warsh uses the Madani
// count, 6214 ayat, vs Hafs's Kufic 6236), so it needs its own verified text +
// page/juz map, never Hafs relabeled.
//
// Sources (golden rule #1: we never hand-type a single ayah, page, or juz):
//
//   1. TEXT, from the King Fahd Complex (KFGQPC) Warsh Uthmanic data set, the
//      authoritative publisher of the Warsh Madani Mushaf. We use the verbatim
//      mirror at thetruetruth/quran-data-kfgqpc (warshData_v10); each record
//      carries (sura_no, aya_no, aya_text, page, jozz). KFGQPC is the canonical
//      digitisation, so there is no competing independent transcription to diff
//      against (the other public "mirrors" are byte-equal copies of this file).
//
//   2. PAGE + JUZ, from the `quran-meta` library (Warsh), an independent project
//      that gives, per ayah, the Madani page (1..604), juz (1..30), and the
//      per-surah Madani ayah counts. We STORE quran-meta's page/juz (one clean
//      value per ayah, the start page, like the Hafs data) and CROSS-CHECK that
//      KFGQPC's own page/jozz agrees on every single ayah, so a parsing or
//      grouping slip in either source cannot pass.
//
// Nothing is written unless every check passes (counts, per-ayah page/juz vs the
// oracle, full page/juz coverage, anchors, non-empty text, Madani markers).

import { createHash } from 'node:crypto';
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { argv } from 'node:process';
import { fileURLToPath } from 'node:url';
import * as WarshMeta from 'quran-meta/warsh';
import type { Surah, AyahNo, AyahId } from 'quran-meta/warsh';
import { loadEnv } from '../src/core';
import { RIWAYAT } from '../src/core/riwayah';

loadEnv();

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(HERE, '..', 'prisma', 'data');
const OUT_JSON = join(DATA_DIR, 'quran-warsh-asbahani.json');

// KFGQPC Warsh Uthmanic data (verbatim mirror). Override with WARSH_SOURCE_URL,
// which may be an http(s) URL or a local file path (used by tests/CI).
const DEFAULT_SOURCE =
  'https://raw.githubusercontent.com/thetruetruth/quran-data-kfgqpc/main/warsh/data/warshData_v10.json';

const RIWAYAH = RIWAYAT['warsh-asbahani'];
const EXPECTED_AYAT = RIWAYAH.ayahCount; // 6214 (Madani)
const PAGE_COUNT = 604;
const JUZ_COUNT = 30;
const SURAH_COUNT = 114;

/** One KFGQPC Warsh record (only the fields we use). */
interface KfgqpcAyah {
  sura_no: number;
  aya_no: number;
  aya_text: string;
  page: string | number;
  jozz: number;
}

/** Output record per ayah (matches the Hafs data file shape). */
interface OutAyah {
  text: string;
  page: number;
  juz: number;
}

/** Strip the trailing ayah-number glyph (Arabic-Indic digits + spaces) the
 *  KFGQPC text carries, and trim. The number is always the last token; Quran
 *  text has no other digits, so this never removes content. */
export function stripAyahNumber(text: string): string {
  return text.replace(/[\s٠-٩۰-۹]+$/u, '').trim();
}

/** The first integer in a KFGQPC page/juz field. The page field can be a RANGE
 *  ("85-86") when an ayah spans two pages; for the wird an ayah belongs to the
 *  page it STARTS on (a single int, like the Hafs data), which is the first
 *  number. Returns NaN for a value with no digits, which the caller rejects. */
export function firstInt(value: string | number): number {
  return parseInt(String(value).match(/\d+/)?.[0] ?? '', 10);
}

async function loadSource(src: string): Promise<KfgqpcAyah[]> {
  const raw = /^https?:\/\//i.test(src)
    ? await (await fetch(src)).text()
    : readFileSync(src, 'utf8');
  const data = JSON.parse(raw) as KfgqpcAyah[];
  if (!Array.isArray(data)) throw new Error('Warsh source is not a JSON array');
  return data;
}

function fail(msg: string): never {
  throw new Error(`Warsh data check failed: ${msg}`);
}

async function main(): Promise<void> {
  const src = process.env.WARSH_SOURCE_URL?.trim() || DEFAULT_SOURCE;
  console.log(`Downloading KFGQPC Warsh data from:\n  ${src}\n`);
  const rows = await loadSource(src);
  const sha256 = createHash('sha256').update(JSON.stringify(rows)).digest('hex');

  // ── Verify the structure oracle agrees, ayah by ayah ──────────────
  if (WarshMeta.meta.numAyahs !== EXPECTED_AYAT)
    fail(`quran-meta says ${WarshMeta.meta.numAyahs} ayat, expected ${EXPECTED_AYAT}`);

  if (rows.length !== EXPECTED_AYAT)
    fail(`source has ${rows.length} ayat, expected ${EXPECTED_AYAT} (Madani count)`);

  // Group by surah, ordered by ayah number, building the output records and
  // checking each ayah's page/juz against the independent oracle.
  const bySurah = new Map<number, OutAyah[]>();
  const pages = new Set<number>();
  const juzs = new Set<number>();

  for (const r of rows) {
    const surah = Number(r.sura_no);
    const ayah = Number(r.aya_no);
    const text = stripAyahNumber(r.aya_text ?? '');

    if (!Number.isInteger(surah) || surah < 1 || surah > SURAH_COUNT)
      fail(`bad surah number ${r.sura_no}`);
    if (!Number.isInteger(ayah) || ayah < 1) fail(`bad ayah number ${r.aya_no} in surah ${surah}`);
    if (text === '') fail(`empty text at ${surah}:${ayah}`);

    // Page and juz come from the structure oracle (quran-meta): a single value
    // per ayah (the start page), matching how the Hafs data stores one int. We
    // then CROSS-CHECK that KFGQPC's own field agrees on the start (its page can
    // be a range like "85-86" for a page-spanning ayah), so the two sources are
    // confirmed in lockstep before anything is written.
    // quran-meta uses branded number types (Surah/AyahNo/AyahId); our values are
    // already range-validated above, so the casts are safe.
    const ayahId = WarshMeta.findAyahIdBySurah(surah as Surah, ayah as AyahNo) as AyahId;
    const page: number = WarshMeta.findPagebyAyahId(ayahId);
    const juz: number = WarshMeta.findJuzByAyahId(ayahId);
    if (!Number.isInteger(page) || page < 1 || page > PAGE_COUNT)
      fail(`oracle gave bad page ${page} at ${surah}:${ayah}`);
    if (!Number.isInteger(juz) || juz < 1 || juz > JUZ_COUNT)
      fail(`oracle gave bad juz ${juz} at ${surah}:${ayah}`);
    const kfgPage = firstInt(r.page);
    const kfgJuz = firstInt(r.jozz);
    if (kfgPage !== page)
      fail(
        `page mismatch at ${surah}:${ayah}: KFGQPC "${r.page}" (start ${kfgPage}) vs oracle ${page}`,
      );
    if (kfgJuz !== juz)
      fail(
        `juz mismatch at ${surah}:${ayah}: KFGQPC "${r.jozz}" (start ${kfgJuz}) vs oracle ${juz}`,
      );

    pages.add(page);
    juzs.add(juz);
    const list = bySurah.get(surah) ?? [];
    list.push({ text, page, juz });
    bySurah.set(surah, list);
  }

  // Per-surah counts must match the oracle's Madani counts exactly, in order.
  if (bySurah.size !== SURAH_COUNT) fail(`got ${bySurah.size} surahs, expected ${SURAH_COUNT}`);
  for (let s = 1; s <= SURAH_COUNT; s++) {
    const list = bySurah.get(s);
    if (!list) fail(`surah ${s} missing`);
    const want = WarshMeta.getAyahCountInSurah(s as Surah);
    if (list.length !== want) fail(`surah ${s} has ${list.length} ayat, oracle says ${want}`);
  }

  // Full coverage of pages and juz.
  if (pages.size !== PAGE_COUNT) fail(`covered ${pages.size} pages, expected ${PAGE_COUNT}`);
  if (juzs.size !== JUZ_COUNT) fail(`covered ${juzs.size} juz, expected ${JUZ_COUNT}`);

  // Anchors (well-known boundaries) + Madani markers, as a final human-legible
  // sanity layer on top of the per-ayah oracle check.
  const fatiha1 = bySurah.get(1)![0];
  const nas = bySurah.get(114)!;
  if (fatiha1.page !== 1 || fatiha1.juz !== 1) fail('1:1 is not on page 1 / juz 1');
  if (nas[nas.length - 1].page !== PAGE_COUNT) fail('last ayah of An-Nas is not on page 604');
  if (bySurah.get(2)!.length !== 285)
    fail(`Al-Baqarah has ${bySurah.get(2)!.length} ayat, Madani must be 285 (Hafs is 286)`);

  // ── Write the frozen data file (same shape as quran-uthmani.json) ──
  const surahs = Array.from({ length: SURAH_COUNT }, (_, i) => ({
    number: i + 1,
    ayat: bySurah.get(i + 1)!,
  }));
  const out = {
    meta: {
      riwayah: 'warsh-asbahani',
      textSource: 'King Fahd Complex (KFGQPC) Warsh Uthmanic data (warshData_v10)',
      textUrl: src,
      structureSource: 'quran-meta (Warsh) — independent page/juz/count oracle',
      countingSchool: RIWAYAH.countingSchool, // madani
      totalAyat: EXPECTED_AYAT,
      totalPages: PAGE_COUNT,
      totalJuz: JUZ_COUNT,
      sha256,
    },
    surahs,
  };
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(OUT_JSON, JSON.stringify(out), 'utf8');

  console.log(`Verified ${EXPECTED_AYAT} ayat, ${PAGE_COUNT} pages, ${JUZ_COUNT} juz (Madani).`);
  console.log(`Per-ayah page/juz confirmed against quran-meta (Warsh).`);
  console.log(`Al-Baqarah: 285 ayat (Madani marker, Hafs is 286).`);
  console.log(`Wrote ${OUT_JSON}`);
  if (!existsSync(OUT_JSON)) fail('output file was not written');
}

// Run only when invoked directly (pnpm data:fetch:warsh), not when imported by
// the unit test for the pure helpers above.
const invokedDirectly =
  argv[1] !== undefined && resolve(argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((err) => {
    console.error(String(err));
    process.exit(1);
  });
}
