// Seed the database from the frozen Quran data file.
//
// Order of operations:
//   1. pnpm data:fetch   -> downloads + verifies + writes the JSON file
//   2. pnpm db:deploy    -> creates the tables (migrations)
//   3. pnpm db:seed      -> this script: fills Surah and Ayah (with page/juz)
//
// This re-checks the data (6236 ayat, right count per surah, 604 pages, 30
// juz) before writing anything, and is safe to run twice: if the text is
// already seeded it just stops. The channel and users are NOT seeded here;
// they are created at runtime from config and from people pressing Start.

import { loadEnv } from '@tilawa/core';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prisma } from '../src/client';
import { SURAHS } from '../src/reference/surahs';
import { AYAH_COUNTS, TOTAL_AYAT } from '../src/reference/ayah-counts';
import { PAGE_COUNT, JUZ_COUNT } from '../src/reference/pages';

loadEnv();

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_FILE = join(HERE, 'data', 'quran-uthmani.json');

interface DataAyah {
  text: string;
  page: number;
  juz: number;
}
interface QuranData {
  meta: { totalAyat: number; totalPages: number; totalJuz: number; sha256: string };
  surahs: { number: number; ayat: DataAyah[] }[];
}

async function main() {
  const data = loadData();
  verify(data);

  // Idempotency guard: if the text is already in place, do nothing.
  const existingAyat = await prisma.ayah.count();
  if (existingAyat === TOTAL_AYAT) {
    console.log('Quran text already seeded (6236 ayat). Nothing to do.');
    return;
  }
  if (existingAyat > 0) {
    throw new Error(
      `Found ${existingAyat} ayat (expected 0 or ${TOTAL_AYAT}). The database is half-seeded. ` +
        `Run "pnpm db:reset" to wipe and reseed.`,
    );
  }

  console.log('Seeding surahs...');
  for (const meta of SURAHS) {
    const ayahCount = data.surahs[meta.number - 1].ayat.length;
    await prisma.surah.create({
      data: {
        number: meta.number,
        nameAr: meta.nameAr,
        nameEn: meta.nameEn,
        revelation: meta.revelation,
        ayahCount,
      },
    });
  }

  console.log('Seeding ayat (with page and juz)...');
  const ayahRows = data.surahs.flatMap((s) =>
    s.ayat.map((a, i) => ({
      surahNumber: s.number,
      numberInSurah: i + 1,
      text: a.text,
      page: a.page,
      juz: a.juz,
    })),
  );
  await createManyChunked('ayat', ayahRows, (chunk) => prisma.ayah.createMany({ data: chunk }));

  console.log(`\nDone. Seeded ${ayahRows.length} ayat across ${SURAHS.length} surahs.`);
}

function loadData(): QuranData {
  try {
    return JSON.parse(readFileSync(DATA_FILE, 'utf8')) as QuranData;
  } catch {
    throw new Error(
      `Could not read ${DATA_FILE}. Run "pnpm data:fetch" first to download the Quran data.`,
    );
  }
}

/** Re-check the file against the oracle before trusting it. */
function verify(data: QuranData): void {
  if (data.surahs.length !== 114) {
    throw new Error(`Data file has ${data.surahs.length} surahs, expected 114. Re-run data:fetch.`);
  }
  let total = 0;
  const pages = new Set<number>();
  const juz = new Set<number>();
  for (let surah = 1; surah <= 114; surah++) {
    const ayat = data.surahs[surah - 1]?.ayat ?? [];
    if (ayat.length !== AYAH_COUNTS[surah]) {
      throw new Error(
        `Data file: surah ${surah} has ${ayat.length} ayat, expected ${AYAH_COUNTS[surah]}. Re-run data:fetch.`,
      );
    }
    for (const a of ayat) {
      if (!Number.isInteger(a.page) || a.page < 1 || a.page > PAGE_COUNT) {
        throw new Error(`Data file: surah ${surah} has an ayah with bad page ${a.page}.`);
      }
      if (!Number.isInteger(a.juz) || a.juz < 1 || a.juz > JUZ_COUNT) {
        throw new Error(`Data file: surah ${surah} has an ayah with bad juz ${a.juz}.`);
      }
      pages.add(a.page);
      juz.add(a.juz);
    }
    total += ayat.length;
  }
  if (total !== TOTAL_AYAT) {
    throw new Error(`Data file totals ${total} ayat, expected ${TOTAL_AYAT}. Re-run data:fetch.`);
  }
  if (pages.size !== PAGE_COUNT) {
    throw new Error(`Data file covers ${pages.size} pages, expected ${PAGE_COUNT}. Re-run data:fetch.`);
  }
  if (juz.size !== JUZ_COUNT) {
    throw new Error(`Data file covers ${juz.size} juz, expected ${JUZ_COUNT}. Re-run data:fetch.`);
  }
}

/** Insert rows in chunks so one giant INSERT never blows the packet size. */
async function createManyChunked<T>(
  label: string,
  rows: T[],
  insert: (chunk: T[]) => Promise<unknown>,
  chunkSize = 500,
): Promise<void> {
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    await insert(chunk);
    console.log(`  ${label}: ${Math.min(i + chunkSize, rows.length)}/${rows.length}`);
  }
}

main()
  .catch((err) => {
    console.error('\nSeed failed:\n', String(err));
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
