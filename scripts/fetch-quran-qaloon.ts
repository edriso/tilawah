// Download the verified Qaloon (قالون عن نافع) Quran data, check it hard, and
// write it to a frozen JSON the seed reads. Run with:
//   pnpm data:fetch:qaloon
//
// Qaloon is the Warsh twin: same Madani count (6214 ayat) and 604-page Madani
// layout, a different rasm. It uses the SAME verified pipeline as Warsh
// (buildRiwayahData in scripts/lib/riwayah-fetch.ts) — only the KFGQPC source
// file, the quran-meta oracle module, and the labels differ. Golden rule #1: we
// never hand-type a single ayah, page, or juz.
//
// Sources:
//   1. TEXT — King Fahd Complex (KFGQPC) Qaloon Uthmanic data, verbatim mirror at
//      thetruetruth/quran-data-kfgqpc (QaloonData_v10).
//   2. PAGE + JUZ — the `quran-meta` library (Qalun), an independent oracle,
//      cross-checked ayah by ayah.

import { dirname, join, resolve } from 'node:path';
import { argv } from 'node:process';
import { fileURLToPath } from 'node:url';
import * as QalunMeta from 'quran-meta/qalun';
import { loadEnv } from '../src/core';
import { buildRiwayahData, type RiwayahMetaModule } from './lib/riwayah-fetch';

loadEnv();

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(HERE, '..', 'prisma', 'data');
const OUT_JSON = join(DATA_DIR, 'quran-qaloon.json');

// KFGQPC Qaloon Uthmanic data (verbatim mirror). Override with QALOON_SOURCE_URL,
// which may be an http(s) URL or a local file path (used by tests/CI).
const DEFAULT_SOURCE =
  'https://raw.githubusercontent.com/thetruetruth/quran-data-kfgqpc/main/qaloon/data/QaloonData_v10.json';

async function main(): Promise<void> {
  await buildRiwayahData({
    riwayah: 'qaloon',
    source: process.env.QALOON_SOURCE_URL?.trim() || DEFAULT_SOURCE,
    // quran-meta uses branded number types; the builder takes plain numbers.
    oracle: QalunMeta as unknown as RiwayahMetaModule,
    dataDir: DATA_DIR,
    outPath: OUT_JSON,
    textSource: 'King Fahd Complex (KFGQPC) Qaloon Uthmanic data (QaloonData_v10)',
    structureSource: 'quran-meta (Qalun) — independent page/juz/count oracle',
    label: 'Qaloon',
  });
}

// Run only when invoked directly (pnpm data:fetch:qaloon).
const invokedDirectly =
  argv[1] !== undefined && resolve(argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((err) => {
    console.error(String(err));
    process.exit(1);
  });
}
