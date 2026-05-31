import { prisma } from '../client';
import { pagesForWird, type PageContent } from '@tilawa/core';
import { TOTAL_AYAT } from '../reference/ayah-counts';
import { PAGE_COUNT, JUZ_COUNT } from '../reference/pages';

/**
 * Make sure the holy text is fully seeded before the bot serves anyone.
 * Called once at startup. If anything is off we refuse to start, so a
 * half-seeded or empty database can never send a wrong page to a reader.
 * The four checks together (114 surahs, 6236 ayat, max page 604, max juz 30)
 * pin the data to the standard Madani Mushaf.
 */
export async function assertQuranSeeded(): Promise<void> {
  const [surahs, ayat, agg] = await Promise.all([
    prisma.surah.count(),
    prisma.ayah.count(),
    prisma.ayah.aggregate({ _max: { page: true, juz: true } }),
  ]);
  const maxPage = agg._max.page ?? 0;
  const maxJuz = agg._max.juz ?? 0;
  if (surahs !== 114 || ayat !== TOTAL_AYAT || maxPage !== PAGE_COUNT || maxJuz !== JUZ_COUNT) {
    throw new Error(
      `Quran data looks wrong: found ${surahs} surahs, ${ayat} ayat, max page ${maxPage}, ` +
        `max juz ${maxJuz}; expected 114, ${TOTAL_AYAT}, ${PAGE_COUNT}, ${JUZ_COUNT}. ` +
        `Run "pnpm data:fetch" then "pnpm db:seed".`,
    );
  }
}

// The basmala is surah 1 ayah 1 in the seeded text. We read it once and cache
// it so we show the exact verified bytes as a surah opening.
let basmalaCache: string | null = null;
export async function getBasmala(): Promise<string> {
  if (basmalaCache !== null) return basmalaCache;
  const opening = await prisma.ayah.findUnique({
    where: { surahNumber_numberInSurah: { surahNumber: 1, numberInSurah: 1 } },
    select: { text: true },
  });
  if (!opening) throw new Error('Basmala (surah 1 ayah 1) not found. Is the Quran text seeded?');
  basmalaCache = opening.text;
  return basmalaCache;
}

/**
 * Load the content of the given pages, grouped per page in the SAME order the
 * pages were asked for (so a wrapping wird like [603, 604, 1] comes back in
 * that order). Each page's juz is the juz of its first ayah, which is what a
 * Mushaf prints in the page header.
 */
export async function getPageContents(pageNumbers: number[]): Promise<PageContent[]> {
  const distinct = [...new Set(pageNumbers)];
  if (distinct.length === 0) return [];

  const rows = await prisma.ayah.findMany({
    where: { page: { in: distinct } },
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

  const byPage = new Map<number, PageContent>();
  for (const r of rows) {
    let page = byPage.get(r.page);
    if (!page) {
      // The first row for a page is its first ayah (rows are ordered), so its
      // juz is the page's juz.
      page = { pageNumber: r.page, juz: r.juz, ayat: [] };
      byPage.set(r.page, page);
    }
    page.ayat.push({
      surahNumber: r.surahNumber,
      surahNameAr: r.surah.nameAr,
      numberInSurah: r.numberInSurah,
      text: r.text,
    });
  }

  return pageNumbers.map((p) => byPage.get(p)).filter((p): p is PageContent => p !== undefined);
}

/** The juz a page belongs to (the juz of its first ayah), or null if the page
 *  is unknown. A light query for the status display. */
export async function getJuzForPage(page: number): Promise<number | null> {
  const row = await prisma.ayah.findFirst({
    where: { page },
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
export async function getWird(startPage: number, wirdSize: number): Promise<PageContent[]> {
  return getPageContents(pagesForWird(startPage, wirdSize));
}
