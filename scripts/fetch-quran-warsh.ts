// Download the verified Warsh (عن نافع، من طريق الأصبهاني) Quran data, check it
// hard, and write it to a frozen JSON the seed reads. Run with:
//   pnpm data:fetch:warsh
//
// This is the Warsh twin of fetch-quran.ts. The riwayah is a different mushaf
// (different rasm AND a different verse-count school: Warsh uses the Madani
// count, 6214 ayat, vs Hafs's Kufic 6236), so it needs its own verified text +
// page/juz map, never Hafs relabeled.
//
// The fetch + cross-check + write is the shared `buildRiwayahData` (see
// scripts/lib/riwayah-fetch.ts), which Qaloon uses too — only the source URL,
// the quran-meta oracle module, and the labels differ. Sources (golden rule #1:
// we never hand-type a single ayah, page, or juz):
//
//   1. TEXT, from the King Fahd Complex (KFGQPC) Warsh Uthmanic data set, the
//      authoritative publisher of the Warsh Madani Mushaf (verbatim mirror at
//      thetruetruth/quran-data-kfgqpc, warshData_v10).
//   2. PAGE + JUZ, from the `quran-meta` library (Warsh), an independent oracle
//      cross-checked ayah by ayah.

import { dirname, join, resolve } from 'node:path';
import { argv } from 'node:process';
import { fileURLToPath } from 'node:url';
import * as WarshMeta from 'quran-meta/warsh';
import { loadEnv } from '../src/core';
import { buildRiwayahData, type RiwayahMetaModule } from './lib/riwayah-fetch';

// Re-export the pure helpers so existing imports/tests keep working; they live
// in the shared builder now.
export { stripAyahNumber, firstInt } from './lib/riwayah-fetch';

loadEnv();

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(HERE, '..', 'prisma', 'data');
// One verified Warsh text file, shared by both turuq (الأزرق + الأصبهاني): same
// rasm + 604-page Madani layout; they differ only in page images + audio.
const OUT_JSON = join(DATA_DIR, 'quran-warsh.json');

// KFGQPC Warsh Uthmanic data (verbatim mirror). Override with WARSH_SOURCE_URL,
// which may be an http(s) URL or a local file path (used by tests/CI).
const DEFAULT_SOURCE =
  'https://raw.githubusercontent.com/thetruetruth/quran-data-kfgqpc/main/warsh/data/warshData_v10.json';

async function main(): Promise<void> {
  await buildRiwayahData({
    riwayah: 'warsh-azraq',
    source: process.env.WARSH_SOURCE_URL?.trim() || DEFAULT_SOURCE,
    // quran-meta uses branded number types; the builder takes plain numbers.
    oracle: WarshMeta as unknown as RiwayahMetaModule,
    dataDir: DATA_DIR,
    outPath: OUT_JSON,
    textSource: 'King Fahd Complex (KFGQPC) Warsh Uthmanic data (warshData_v10)',
    structureSource: 'quran-meta (Warsh) — independent page/juz/count oracle',
    label: 'Warsh',
  });
}

// Run only when invoked directly (pnpm data:fetch:warsh), not when imported by
// the unit test for the re-exported pure helpers above.
const invokedDirectly =
  argv[1] !== undefined && resolve(argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((err) => {
    console.error(String(err));
    process.exit(1);
  });
}
