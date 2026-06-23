import { prisma } from '../client';
import {
  pagesForWird,
  RIWAYAT,
  DEFAULT_RIWAYAH,
  type RiwayahKey,
  type PageContent,
  type LessonExample,
} from '../../core';
import { TOTAL_AYAT } from '../reference/ayah-counts';
import { PAGE_COUNT, JUZ_COUNT } from '../reference/pages';

/**
 * Make sure the holy text is fully seeded before the bot serves anyone.
 * Called once at startup. If anything is off we refuse to start, so a
 * half-seeded or empty database can never send a wrong page to a reader.
 *
 * Hafs is REQUIRED (the default riwayah everyone gets) and checked strictly
 * (6236 ayat, max page 604, max juz 30). Every other riwayah is OPTIONAL: if it
 * has any ayat it must be COMPLETE (its own Madani count, full 604/30), else the
 * boot fails; if it has none it is simply not offered (see availableRiwayat).
 * Surahs are shared metadata, seeded once.
 */
export async function assertQuranSeeded(): Promise<void> {
  const surahs = await prisma.surah.count();
  if (surahs !== 114) {
    throw new Error(
      `Found ${surahs} surahs, expected 114. Run "pnpm data:fetch" then "pnpm db:seed".`,
    );
  }
  await assertRiwayahSeeded('hafs', TOTAL_AYAT, true);
  for (const r of Object.values(RIWAYAT)) {
    if (r.key !== 'hafs') await assertRiwayahSeeded(r.key, r.ayahCount, false);
  }
}

/** Check one riwayah's ayat: complete (its Madani count + full page/juz) when
 *  present; absent is fatal only when `required`. */
async function assertRiwayahSeeded(
  riwayah: RiwayahKey,
  expected: number,
  required: boolean,
): Promise<void> {
  const [ayat, agg] = await Promise.all([
    prisma.ayah.count({ where: { riwayah } }),
    prisma.ayah.aggregate({ where: { riwayah }, _max: { page: true, juz: true } }),
  ]);
  if (ayat === 0) {
    if (required) throw new Error(`Riwayah "${riwayah}" is not seeded. Run "pnpm db:seed".`);
    return; // optional + absent: not offered, see availableRiwayat
  }
  const maxPage = agg._max.page ?? 0;
  const maxJuz = agg._max.juz ?? 0;
  if (ayat !== expected || maxPage !== PAGE_COUNT || maxJuz !== JUZ_COUNT) {
    throw new Error(
      `Riwayah "${riwayah}" looks half-seeded: ${ayat} ayat, max page ${maxPage}, max juz ${maxJuz}; ` +
        `expected ${expected}, ${PAGE_COUNT}, ${JUZ_COUNT}. Re-run its data:fetch + db:seed.`,
    );
  }
}

/**
 * The riwayat actually seeded in this database, in registry order (Hafs first).
 * Hafs is always present; another appears only once its verified data has been
 * seeded. The UX offers exactly these, so a riwayah with no data is never shown.
 */
export async function availableRiwayat(): Promise<RiwayahKey[]> {
  const grouped = await prisma.ayah.groupBy({ by: ['riwayah'] });
  const present = new Set(grouped.map((g) => g.riwayah));
  return (Object.keys(RIWAYAT) as RiwayahKey[]).filter((k) => present.has(k));
}

// The basmala is surah 1 ayah 1 in the seeded text. We read it once and cache
// it so we show the exact verified bytes as a surah opening.
let basmalaCache: string | null = null;
export async function getBasmala(): Promise<string> {
  if (basmalaCache !== null) return basmalaCache;
  // The basmala is surah 1 ayah 1 in the Hafs/Kufic mushaf (in the Madani count
  // it is not numbered, so we always read it from the always-present Hafs text);
  // these are the canonical verified bytes, used as a surah opening for any
  // riwayah's text format.
  const opening = await prisma.ayah.findUnique({
    where: {
      riwayah_surahNumber_numberInSurah: { riwayah: 'hafs', surahNumber: 1, numberInSurah: 1 },
    },
    select: { text: true },
  });
  if (!opening) throw new Error('Basmala (surah 1 ayah 1) not found. Is the Quran text seeded?');
  basmalaCache = opening.text;
  return basmalaCache;
}

// Page content never changes after seeding (the ayat tables are read-only, and
// assertQuranSeeded guards them at boot), so we cache each page the first time
// it is read. The daily delivery loop sends the same handful of pages to many
// subscribers every tick; without this it would re-query the database once per
// subscriber. Consumers only READ the returned PageContent, so sharing the
// cached object is safe. At most 604 small entries.
// Keyed by `${riwayah}:${page}`, since a Warsh page 25 holds different ayat
// from a Hafs page 25.
const pageCache = new Map<string, PageContent>();
const pageKey = (riwayah: RiwayahKey, page: number) => `${riwayah}:${page}`;

/**
 * Load the content of the given pages (in the subscriber's riwayah), grouped per
 * page in the SAME order the pages were asked for (so a wrapping wird like
 * [603, 604, 1] comes back in that order). Each page's juz is the juz of its
 * first ayah, which is what a Mushaf prints in the page header. Cached, since
 * pages are immutable. Defaults to Hafs.
 */
export async function getPageContents(
  pageNumbers: number[],
  riwayah: RiwayahKey = DEFAULT_RIWAYAH,
): Promise<PageContent[]> {
  const distinct = [...new Set(pageNumbers)];
  if (distinct.length === 0) return [];

  const missing = distinct.filter((p) => !pageCache.has(pageKey(riwayah, p)));
  if (missing.length > 0) {
    const rows = await prisma.ayah.findMany({
      where: { riwayah, page: { in: missing } },
      orderBy: [{ page: 'asc' }, { surahNumber: 'asc' }, { numberInSurah: 'asc' }],
      select: {
        page: true,
        juz: true,
        surahNumber: true,
        numberInSurah: true,
        text: true,
        surah: { select: { nameAr: true } },
      },
    });

    const built = new Map<number, PageContent>();
    for (const r of rows) {
      let page = built.get(r.page);
      if (!page) {
        // The first row for a page is its first ayah (rows are ordered), so
        // its juz is the page's starting juz.
        page = { pageNumber: r.page, juz: r.juz, juzEnd: r.juz, ayat: [] };
        built.set(r.page, page);
      }
      // Rows are in reading order and juz never decreases within a page, so the
      // last row's juz is the page's ending juz (greater only when the page
      // straddles a juz boundary).
      page.juzEnd = r.juz;
      page.ayat.push({
        surahNumber: r.surahNumber,
        surahNameAr: r.surah.nameAr,
        numberInSurah: r.numberInSurah,
        text: r.text,
      });
    }
    for (const [num, content] of built) pageCache.set(pageKey(riwayah, num), content);
  }

  return pageNumbers
    .map((p) => pageCache.get(pageKey(riwayah, p)))
    .filter((p): p is PageContent => p !== undefined);
}

/** The verified text of one ayah (with its surah's Arabic name), or null if it
 *  is not seeded. Used to render a tajweed lesson's example from the database,
 *  so the example text is always the verified Uthmani text, never typed. */
export async function getAyahText(
  surahNumber: number,
  numberInSurah: number,
): Promise<LessonExample | null> {
  // The tajweed lessons reference Hafs ayat (their numbering), so read from Hafs.
  const row = await prisma.ayah.findUnique({
    where: {
      riwayah_surahNumber_numberInSurah: { riwayah: 'hafs', surahNumber, numberInSurah },
    },
    select: { numberInSurah: true, text: true, surah: { select: { nameAr: true } } },
  });
  if (!row) return null;
  return { numberInSurah: row.numberInSurah, text: row.text, surahNameAr: row.surah.nameAr };
}

/** The juz a page belongs to (the juz of its first ayah), or null if the page
 *  is unknown. A light query for the status display. */
export async function getJuzForPage(
  page: number,
  riwayah: RiwayahKey = DEFAULT_RIWAYAH,
): Promise<number | null> {
  const row = await prisma.ayah.findFirst({
    where: { riwayah, page },
    orderBy: [{ surahNumber: 'asc' }, { numberInSurah: 'asc' }],
    select: { juz: true },
  });
  return row?.juz ?? null;
}

/**
 * The pages of a wird: starting at `startPage`, taking `wirdSize` pages,
 * wrapping past page 604 back to 1. Pure page math (pagesForWird) decides the
 * page numbers; this just loads their content in reading order.
 */
export async function getWird(
  startPage: number,
  wirdSize: number,
  riwayah: RiwayahKey = DEFAULT_RIWAYAH,
): Promise<PageContent[]> {
  return getPageContents(pagesForWird(startPage, wirdSize), riwayah);
}
