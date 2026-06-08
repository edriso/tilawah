import { InlineKeyboard } from 'grammy';
import { toArabicDigits } from '../core';
import { COPY } from './copy';

// The tajweed-lessons browser: a paginated index of the whole deck, opened from
// the /tajweed message. Same shape as the ayah bot's surah picker (one button
// per item, a prev/indicator/next nav row), so the two bots feel the same.
// Browsing is read-only — it never moves the reader's daily lesson position.
//
// Callback data, namespaced like the other pickers and tiny (well under
// Telegram's 64-byte limit):
//   open  -> "tilawah:tjwl:open"        (open the index at page 0)
//   page  -> "tilawah:tjwl:page:<n>"    (show list page n; also the "back" target)
//   pick  -> "tilawah:tjwl:pick:<i>"    (show lesson at deck index i)
//   noop  -> "tilawah:tjwl:noop"        (the page indicator; just acknowledged)
export const LESSONS_OPEN = 'tilawah:tjwl:open';
export const LESSONS_PAGE_PREFIX = 'tilawah:tjwl:page:';
export const LESSONS_PICK_PREFIX = 'tilawah:tjwl:pick:';
export const LESSONS_NOOP = 'tilawah:tjwl:noop';

// Lessons per page: one per row (the titles are long, e.g. "المخارج: طرف اللسان
// (اللام والنون والراء)"), 8 a page keeps the message short and tappable. 45
// lessons span 6 pages.
export const LESSONS_PAGE_SIZE = 8;

/** Total list pages for `count` lessons, at least one. */
export function lessonsPageCount(count: number): number {
  return Math.max(1, Math.ceil(count / LESSONS_PAGE_SIZE));
}

/** Force a page index into 0..lastPage, so a stale/old button can never throw. */
export function clampLessonsPage(page: number, count: number): number {
  const last = lessonsPageCount(count) - 1;
  if (!Number.isFinite(page) || page < 0) return 0;
  return page > last ? last : page;
}

/** The list page that holds a given lesson index — the "back to list" target so
 *  returning from a lesson lands on the page it was opened from. */
export function pageForLesson(index: number): number {
  return Math.floor(Math.max(0, index) / LESSONS_PAGE_SIZE);
}

/** The minimum a lesson needs to render a pick button. */
export interface LessonButton {
  titleAr: string;
}

/**
 * Build the paginated lessons index. Each button shows "٥. المد الطبيعي" (the
 * deck's 1-based number + title) and, when tapped, opens that lesson. The nav
 * row carries previous/next (only when there is somewhere to go) around a
 * non-acting page indicator. The lessons list is passed in (not imported) so
 * this stays a pure UI builder.
 */
export function buildLessonsKeyboard(lessons: readonly LessonButton[], page = 0): InlineKeyboard {
  const safePage = clampLessonsPage(page, lessons.length);
  const start = safePage * LESSONS_PAGE_SIZE;
  const slice = lessons.slice(start, start + LESSONS_PAGE_SIZE);

  const kb = new InlineKeyboard();
  slice.forEach((lesson, i) => {
    const index = start + i;
    kb.text(
      `${toArabicDigits(index + 1)}. ${lesson.titleAr}`,
      `${LESSONS_PICK_PREFIX}${index}`,
    ).row();
  });

  // Navigation row. The indicator re-renders nothing (a noop) because every
  // Telegram button needs callback data.
  const last = lessonsPageCount(lessons.length) - 1;
  if (safePage > 0) kb.text('« السابق', `${LESSONS_PAGE_PREFIX}${safePage - 1}`);
  kb.text(`${toArabicDigits(safePage + 1)}/${toArabicDigits(last + 1)}`, LESSONS_NOOP);
  if (safePage < last) kb.text('التالي »', `${LESSONS_PAGE_PREFIX}${safePage + 1}`);
  return kb;
}

/** The keyboard under a single browsed lesson: one button back to the list page
 *  the lesson was opened from. */
export function buildLessonViewKeyboard(index: number): InlineKeyboard {
  return new InlineKeyboard().text(
    COPY.tajweedBackBtn,
    `${LESSONS_PAGE_PREFIX}${pageForLesson(index)}`,
  );
}
