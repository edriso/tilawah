// Seed the database from the frozen Quran data files.
//
// Order of operations:
//   1. pnpm data:fetch         -> downloads + verifies + writes quran-uthmani.json (Hafs)
//   1b. pnpm data:fetch:warsh  -> (optional) writes quran-warsh-asbahani.json (Warsh)
//   1c. pnpm data:fetch:qaloon -> (optional) writes quran-qaloon.json (Qaloon)
//   2. pnpm db:deploy          -> creates the tables (migrations)
//   3. pnpm db:seed           -> this script: fills Surah and Ayah (with page/juz)
//
// Each riwayah's file is re-checked before anything is written, and the seed is
// safe to run twice: a fully-seeded riwayah is skipped. Hafs is required; any
// other riwayah is seeded only if its data file is present (else it is simply
// not offered, see availableRiwayat). The channel and users are NOT seeded here;
// they are created at runtime. We never hand-type a single ayah, page, or juz.

import { loadEnv } from '../src/core';
import { RIWAYAT, type RiwayahKey } from '../src/core/riwayah';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prisma } from '../src/database/client';
import { SURAHS } from '../src/database/reference/surahs';
import { AYAH_COUNTS, TOTAL_AYAT } from '../src/database/reference/ayah-counts';
import { PAGE_COUNT, JUZ_COUNT } from '../src/database/reference/pages';

loadEnv();

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(HERE, 'data');

interface DataAyah {
  text: string;
  page: number;
  juz: number;
}
interface QuranData {
  surahs: { number: number; ayat: DataAyah[] }[];
}

/** One riwayah to seed. `perSurah` (Hafs) enables the strict per-surah count
 *  check; for other riwayat the file's own structure (already cross-verified at
 *  fetch time against quran-meta) is checked against its total. `required` makes
 *  a missing file fatal; `seedSurahs` seeds the shared Surah table (Hafs only). */
interface RiwayahSpec {
  riwayah: RiwayahKey;
  file: string;
  total: number;
  perSurah: Record<number, number> | null;
  required: boolean;
  seedSurahs: boolean;
}

const RIWAYAT_TO_SEED: RiwayahSpec[] = [
  {
    riwayah: 'hafs',
    file: 'quran-uthmani.json',
    total: TOTAL_AYAT,
    perSurah: AYAH_COUNTS,
    required: true,
    seedSurahs: true,
  },
  {
    riwayah: 'warsh-asbahani',
    file: 'quran-warsh-asbahani.json',
    total: RIWAYAT['warsh-asbahani'].ayahCount, // 6214 (Madani)
    perSurah: null,
    required: false,
    seedSurahs: false,
  },
  {
    riwayah: 'qaloon',
    file: 'quran-qaloon.json',
    total: RIWAYAT.qaloon.ayahCount, // 6214 (Madani)
    perSurah: null,
    required: false,
    seedSurahs: false,
  },
];

async function main() {
  for (const spec of RIWAYAT_TO_SEED) await seedRiwayah(spec);
  console.log('\nSeed complete.');
}

async function seedRiwayah(spec: RiwayahSpec): Promise<void> {
  const path = join(DATA_DIR, spec.file);
  if (!existsSync(path)) {
    if (spec.required) {
      throw new Error(`Missing ${spec.file}. Run "pnpm data:fetch" first.`);
    }
    console.log(`Riwayah "${spec.riwayah}": data file absent, skipping (not offered).`);
    return;
  }

  const data = loadData(path, spec.file);
  verify(data, spec);

  // Idempotency, per riwayah: skip when complete, refuse a half-seeded state.
  const existing = await prisma.ayah.count({ where: { riwayah: spec.riwayah } });
  if (existing === spec.total) {
    console.log(`Riwayah "${spec.riwayah}" already seeded (${spec.total} ayat). Nothing to do.`);
    return;
  }
  if (existing > 0) {
    throw new Error(
      `Riwayah "${spec.riwayah}" has ${existing} ayat (expected 0 or ${spec.total}). ` +
        `Half-seeded. Run "pnpm db:reset" to wipe and reseed.`,
    );
  }

  // The Surah table is shared metadata, seeded once (from Hafs).
  if (spec.seedSurahs && (await prisma.surah.count()) === 0) {
    console.log('Seeding surahs...');
    for (const meta of SURAHS) {
      await prisma.surah.create({
        data: {
          number: meta.number,
          nameAr: meta.nameAr,
          nameEn: meta.nameEn,
          revelation: meta.revelation,
          ayahCount: data.surahs[meta.number - 1].ayat.length,
        },
      });
    }
  }

  console.log(`Seeding "${spec.riwayah}" ayat (with page and juz)...`);
  const ayahRows = data.surahs.flatMap((s) =>
    s.ayat.map((a, i) => ({
      riwayah: spec.riwayah,
      surahNumber: s.number,
      numberInSurah: i + 1,
      text: a.text,
      page: a.page,
      juz: a.juz,
    })),
  );
  await createManyChunked(`${spec.riwayah} ayat`, ayahRows, (chunk) =>
    prisma.ayah.createMany({ data: chunk }),
  );
  console.log(`  Seeded ${ayahRows.length} "${spec.riwayah}" ayat.`);
}

function loadData(path: string, file: string): QuranData {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as QuranData;
  } catch {
    throw new Error(`Could not read ${path}. Re-run the data:fetch that writes ${file}.`);
  }
}

/** Re-check the file before trusting it. Hafs gets the strict per-surah oracle
 *  check; every riwayah is checked for 114 surahs, its total, valid page/juz,
 *  and full 604-page / 30-juz coverage. */
function verify(data: QuranData, spec: RiwayahSpec): void {
  if (data.surahs.length !== 114) {
    throw new Error(`${spec.file}: ${data.surahs.length} surahs, expected 114. Re-run data:fetch.`);
  }
  let total = 0;
  const pages = new Set<number>();
  const juz = new Set<number>();
  for (let surah = 1; surah <= 114; surah++) {
    const ayat = data.surahs[surah - 1]?.ayat ?? [];
    if (spec.perSurah && ayat.length !== spec.perSurah[surah]) {
      throw new Error(
        `${spec.file}: surah ${surah} has ${ayat.length} ayat, expected ${spec.perSurah[surah]}. Re-run data:fetch.`,
      );
    }
    for (const a of ayat) {
      if (!Number.isInteger(a.page) || a.page < 1 || a.page > PAGE_COUNT)
        throw new Error(`${spec.file}: surah ${surah} has an ayah with bad page ${a.page}.`);
      if (!Number.isInteger(a.juz) || a.juz < 1 || a.juz > JUZ_COUNT)
        throw new Error(`${spec.file}: surah ${surah} has an ayah with bad juz ${a.juz}.`);
      if (typeof a.text !== 'string' || a.text.trim() === '')
        throw new Error(`${spec.file}: surah ${surah} has an empty ayah.`);
      pages.add(a.page);
      juz.add(a.juz);
    }
    total += ayat.length;
  }
  if (total !== spec.total)
    throw new Error(
      `${spec.file} totals ${total} ayat, expected ${spec.total}. Re-run data:fetch.`,
    );
  if (pages.size !== PAGE_COUNT)
    throw new Error(`${spec.file} covers ${pages.size} pages, expected ${PAGE_COUNT}.`);
  if (juz.size !== JUZ_COUNT)
    throw new Error(`${spec.file} covers ${juz.size} juz, expected ${JUZ_COUNT}.`);
}

/** Insert rows in chunks so one giant INSERT never blows the packet size. */
async function createManyChunked<T>(
  label: string,
  rows: T[],
  insert: (chunk: T[]) => Promise<unknown>,
  chunkSize = 500,
): Promise<void> {
  for (let i = 0; i < rows.length; i += chunkSize) {
    await insert(rows.slice(i, i + chunkSize));
    console.log(`  ${label}: ${Math.min(i + chunkSize, rows.length)}/${rows.length}`);
  }
}

main()
  .catch((err) => {
    console.error('\nSeed failed:\n', String(err));
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
