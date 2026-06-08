import { describe, it, expect } from 'vitest';
import type { InlineKeyboardButton } from 'grammy/types';
import {
  buildLessonsKeyboard,
  buildLessonViewKeyboard,
  lessonsPageCount,
  clampLessonsPage,
  pageForLesson,
  LESSONS_PAGE_SIZE,
  LESSONS_PAGE_PREFIX,
  LESSONS_PICK_PREFIX,
  LESSONS_NOOP,
} from './tajweed-lessons-keyboard';

// A stand-in deck of 45 lessons (the real count), enough to span several pages.
const lessons = Array.from({ length: 45 }, (_, i) => ({ titleAr: `درس ${i + 1}` }));

function buttons(kb: ReturnType<typeof buildLessonsKeyboard>) {
  return kb.inline_keyboard.flat();
}
function cd(b: InlineKeyboardButton): string | undefined {
  return 'callback_data' in b ? b.callback_data : undefined;
}
function picks(kb: ReturnType<typeof buildLessonsKeyboard>) {
  return buttons(kb).filter((b) => cd(b)?.startsWith(LESSONS_PICK_PREFIX));
}

describe('lessonsPageCount / clampLessonsPage / pageForLesson', () => {
  it('counts pages (at least one) and clamps out-of-range pages', () => {
    expect(lessonsPageCount(45)).toBe(Math.ceil(45 / LESSONS_PAGE_SIZE));
    expect(lessonsPageCount(0)).toBe(1);
    expect(clampLessonsPage(999, 45)).toBe(lessonsPageCount(45) - 1);
    expect(clampLessonsPage(-3, 45)).toBe(0);
  });

  it('maps a lesson index to the list page it lives on (the back target)', () => {
    expect(pageForLesson(0)).toBe(0);
    expect(pageForLesson(LESSONS_PAGE_SIZE - 1)).toBe(0);
    expect(pageForLesson(LESSONS_PAGE_SIZE)).toBe(1);
    expect(pageForLesson(44)).toBe(Math.floor(44 / LESSONS_PAGE_SIZE));
  });
});

describe('buildLessonsKeyboard', () => {
  it('shows one button per lesson on the page, numbered + titled, in order', () => {
    const p = picks(buildLessonsKeyboard(lessons, 0));
    expect(p).toHaveLength(LESSONS_PAGE_SIZE);
    expect(cd(p[0]!)).toBe(`${LESSONS_PICK_PREFIX}0`);
    expect(p[0]!.text).toContain('١.'); // 1-based Arabic-Indic number
    expect(p[0]!.text).toContain('درس 1');
  });

  it('uses GLOBAL deck indices on a later page (page 1 starts at PAGE_SIZE)', () => {
    const p = picks(buildLessonsKeyboard(lessons, 1));
    expect(cd(p[0]!)).toBe(`${LESSONS_PICK_PREFIX}${LESSONS_PAGE_SIZE}`);
  });

  it('first page has next but no previous, plus a noop indicator', () => {
    const all = buttons(buildLessonsKeyboard(lessons, 0));
    expect(all.some((b) => cd(b) === `${LESSONS_PAGE_PREFIX}1`)).toBe(true);
    expect(all.some((b) => cd(b) === LESSONS_NOOP)).toBe(true);
    // No page button other than "next" (no previous on the first page).
    const pageBtns = all.filter((b) => cd(b)?.startsWith(LESSONS_PAGE_PREFIX));
    expect(pageBtns).toHaveLength(1);
  });

  it('last page has previous but no next', () => {
    const last = lessonsPageCount(lessons.length) - 1;
    const all = buttons(buildLessonsKeyboard(lessons, last));
    expect(all.some((b) => cd(b) === `${LESSONS_PAGE_PREFIX}${last - 1}`)).toBe(true);
    expect(all.some((b) => cd(b) === `${LESSONS_PAGE_PREFIX}${last + 1}`)).toBe(false);
  });

  it('clamps an out-of-range page instead of rendering an empty list', () => {
    expect(picks(buildLessonsKeyboard(lessons, 999)).length).toBeGreaterThan(0);
  });
});

describe('buildLessonViewKeyboard', () => {
  it('offers a single back button to the lesson’s own list page', () => {
    const all = buttons(buildLessonViewKeyboard(20));
    expect(all).toHaveLength(1);
    expect(cd(all[0]!)).toBe(`${LESSONS_PAGE_PREFIX}${pageForLesson(20)}`);
  });
});
