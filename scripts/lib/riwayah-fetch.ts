// Shared builder for a non-Hafs riwayah's verified text + page/juz map.
//
// Warsh and Qaloon are fetched the same way: a KFGQPC Uthmanic text mirror (one
// record per ayah: sura_no, aya_no, aya_text, page, jozz) CROSS-CHECKED, ayah by
// ayah, against the independent `quran-meta` oracle for that riwayah (page, juz,
// per-surah counts). Nothing is written unless every check passes. Both riwayat
// use the Madani count (6214) and the 604-page Madani layout, so the logic is
// identical — only the source URL, the oracle module, and a few labels differ.
// Keeping it in one place means the two fetchers can never drift.
//
// Golden rule #1: we never hand-type a single ayah, page, or juz — every value
// comes from a verified source and is checked before it is written.

import { createHash } from 'node:crypto';
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { RIWAYAT, type RiwayahKey } from '../../src/core/riwayah';

const PAGE_COUNT = 604;
const JUZ_COUNT = 30;
const SURAH_COUNT = 114;

/** One KFGQPC record (only the fields we use). */
export interface KfgqpcAyah {
  sura_no: number;
  aya_no: number;
  aya_text: string;
  page: string | number;
  jozz: number;
}

/** Output record per ayah (matches the Hafs data file shape). */
export interface OutAyah {
  text: string;
  page: number;
  juz: number;
}

/** The slice of a `quran-meta/<riwayah>` module this builder needs. The library
 *  uses branded number types (Surah/AyahNo/AyahId); the call site passes the
 *  module with a cast, and we use plain numbers here (already range-validated). */
export interface RiwayahMetaModule {
  meta: { numAyahs: number };
  findAyahIdBySurah(surah: number, ayah: number): number;
  findPagebyAyahId(ayahId: number): number;
  findJuzByAyahId(ayahId: number): number;
  getAyahCountInSurah(surah: number): number;
}

export interface BuildOptions {
  /** Which riwayah (its ayahCount + countingSchool come from the registry). */
  riwayah: RiwayahKey;
  /** The resolved text source: an http(s) URL or a local file path. */
  source: string;
  /** The `quran-meta/<riwayah>` oracle module. */
  oracle: RiwayahMetaModule;
  /** Where the data dir and output JSON live (absolute paths). */
  dataDir: string;
  outPath: string;
  /** Labels written into the output `meta` block, for provenance. */
  textSource: string;
  structureSource: string;
  /** Human label for log lines, e.g. "Warsh" or "Qaloon". */
  label: string;
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
  if (!Array.isArray(data)) throw new Error('riwayah source is not a JSON array');
  return data;
}

/**
 * Download (or read) the riwayah text, verify it hard against the oracle, and
 * write the frozen JSON the seed reads. Throws on the first failed check, so a
 * parsing/grouping slip in either source can never reach the database.
 */
export async function buildRiwayahData(opts: BuildOptions): Promise<void> {
  const { riwayah, source, oracle, dataDir, outPath, label } = opts;
  const r = RIWAYAT[riwayah];
  const EXPECTED_AYAT = r.ayahCount; // 6214 (Madani) for Warsh/Qaloon

  const fail = (msg: string): never => {
    throw new Error(`${label} data check failed: ${msg}`);
  };

  console.log(`Downloading KFGQPC ${label} data from:\n  ${source}\n`);
  const rows = await loadSource(source);
  const sha256 = createHash('sha256').update(JSON.stringify(rows)).digest('hex');

  // ── Verify the structure oracle agrees, ayah by ayah ──────────────
  if (oracle.meta.numAyahs !== EXPECTED_AYAT)
    fail(`quran-meta says ${oracle.meta.numAyahs} ayat, expected ${EXPECTED_AYAT}`);
  if (rows.length !== EXPECTED_AYAT)
    fail(`source has ${rows.length} ayat, expected ${EXPECTED_AYAT} (Madani count)`);

  const bySurah = new Map<number, OutAyah[]>();
  const pages = new Set<number>();
  const juzs = new Set<number>();

  for (const row of rows) {
    const surah = Number(row.sura_no);
    const ayah = Number(row.aya_no);
    const text = stripAyahNumber(row.aya_text ?? '');

    if (!Number.isInteger(surah) || surah < 1 || surah > SURAH_COUNT)
      fail(`bad surah number ${row.sura_no}`);
    if (!Number.isInteger(ayah) || ayah < 1)
      fail(`bad ayah number ${row.aya_no} in surah ${surah}`);
    if (text === '') fail(`empty text at ${surah}:${ayah}`);

    // Page and juz come from the structure oracle (quran-meta): a single value
    // per ayah (the start page), matching how the Hafs data stores one int. We
    // then CROSS-CHECK that KFGQPC's own field agrees on the start (its page can
    // be a range like "85-86" for a page-spanning ayah), so the two sources are
    // confirmed in lockstep before anything is written.
    const ayahId = oracle.findAyahIdBySurah(surah, ayah);
    const page = oracle.findPagebyAyahId(ayahId);
    const juz = oracle.findJuzByAyahId(ayahId);
    if (!Number.isInteger(page) || page < 1 || page > PAGE_COUNT)
      fail(`oracle gave bad page ${page} at ${surah}:${ayah}`);
    if (!Number.isInteger(juz) || juz < 1 || juz > JUZ_COUNT)
      fail(`oracle gave bad juz ${juz} at ${surah}:${ayah}`);
    const kfgPage = firstInt(row.page);
    const kfgJuz = firstInt(row.jozz);
    if (kfgPage !== page)
      fail(
        `page mismatch at ${surah}:${ayah}: KFGQPC "${row.page}" (start ${kfgPage}) vs oracle ${page}`,
      );
    if (kfgJuz !== juz)
      fail(
        `juz mismatch at ${surah}:${ayah}: KFGQPC "${row.jozz}" (start ${kfgJuz}) vs oracle ${juz}`,
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
    const want = oracle.getAyahCountInSurah(s);
    if (list!.length !== want) fail(`surah ${s} has ${list!.length} ayat, oracle says ${want}`);
  }

  // Full coverage of pages and juz.
  if (pages.size !== PAGE_COUNT) fail(`covered ${pages.size} pages, expected ${PAGE_COUNT}`);
  if (juzs.size !== JUZ_COUNT) fail(`covered ${juzs.size} juz, expected ${JUZ_COUNT}`);

  // Anchors (well-known boundaries) + Madani markers, as a final human-legible
  // sanity layer on top of the per-ayah oracle check.
  const fatiha1 = bySurah.get(1)![0]!;
  const nas = bySurah.get(114)!;
  if (fatiha1.page !== 1 || fatiha1.juz !== 1) fail('1:1 is not on page 1 / juz 1');
  if (nas[nas.length - 1]!.page !== PAGE_COUNT) fail('last ayah of An-Nas is not on page 604');
  if (bySurah.get(2)!.length !== 285)
    fail(`Al-Baqarah has ${bySurah.get(2)!.length} ayat, Madani must be 285 (Hafs is 286)`);

  // ── Write the frozen data file (same shape as quran-uthmani.json) ──
  const surahs = Array.from({ length: SURAH_COUNT }, (_, i) => ({
    number: i + 1,
    ayat: bySurah.get(i + 1)!,
  }));
  const out = {
    meta: {
      riwayah,
      textSource: opts.textSource,
      textUrl: source,
      structureSource: opts.structureSource,
      countingSchool: r.countingSchool, // madani
      totalAyat: EXPECTED_AYAT,
      totalPages: PAGE_COUNT,
      totalJuz: JUZ_COUNT,
      sha256,
    },
    surahs,
  };
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(outPath, JSON.stringify(out), 'utf8');

  console.log(`Verified ${EXPECTED_AYAT} ayat, ${PAGE_COUNT} pages, ${JUZ_COUNT} juz (Madani).`);
  console.log(`Per-ayah page/juz confirmed against quran-meta (${label}).`);
  console.log(`Al-Baqarah: 285 ayat (Madani marker, Hafs is 286).`);
  console.log(`Wrote ${outPath}`);
  if (!existsSync(outPath)) fail('output file was not written');
}
