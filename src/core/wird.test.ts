import { describe, it, expect } from 'vitest';
import {
  TOTAL_PAGES,
  DEFAULT_WIRD_PAGES,
  MAX_WIRD_PAGES,
  clampWirdSize,
  isValidPage,
  pagesForWird,
  advanceStartPage,
  nextPageAfter,
  khatmaDays,
} from './wird';

describe('constants', () => {
  it('match the standard Madani Mushaf and the wird policy', () => {
    expect(TOTAL_PAGES).toBe(604);
    expect(DEFAULT_WIRD_PAGES).toBe(1);
    expect(MAX_WIRD_PAGES).toBe(20);
  });
});

describe('clampWirdSize', () => {
  it('keeps values in range and clamps the rest', () => {
    expect(clampWirdSize(1)).toBe(1);
    expect(clampWirdSize(20)).toBe(20);
    expect(clampWirdSize(0)).toBe(1);
    expect(clampWirdSize(-5)).toBe(1);
    expect(clampWirdSize(21)).toBe(20);
    expect(clampWirdSize(1000)).toBe(20);
  });

  it('truncates fractions and falls back to the default on non-finite input', () => {
    expect(clampWirdSize(3.9)).toBe(3);
    expect(clampWirdSize(NaN)).toBe(DEFAULT_WIRD_PAGES);
    expect(clampWirdSize(Infinity)).toBe(DEFAULT_WIRD_PAGES);
  });
});

describe('isValidPage', () => {
  it('accepts 1..604 whole numbers only', () => {
    expect(isValidPage(1)).toBe(true);
    expect(isValidPage(604)).toBe(true);
    expect(isValidPage(0)).toBe(false);
    expect(isValidPage(605)).toBe(false);
    expect(isValidPage(2.5)).toBe(false);
    expect(isValidPage(NaN)).toBe(false);
  });
});

describe('pagesForWird', () => {
  it('returns the simple in-range run', () => {
    expect(pagesForWird(1, 1)).toEqual([1]);
    expect(pagesForWird(10, 3)).toEqual([10, 11, 12]);
  });

  it('wraps cleanly past the last page', () => {
    expect(pagesForWird(603, 3)).toEqual([603, 604, 1]);
    expect(pagesForWird(604, 2)).toEqual([604, 1]);
  });

  it('clamps an out-of-range size instead of producing a huge list', () => {
    expect(pagesForWird(1, 100)).toHaveLength(MAX_WIRD_PAGES);
    expect(pagesForWird(1, 0)).toEqual([1]);
  });

  it('rejects an invalid start page', () => {
    expect(() => pagesForWird(0, 1)).toThrow();
    expect(() => pagesForWird(605, 1)).toThrow();
  });
});

describe('advanceStartPage', () => {
  it('moves forward by the wird size', () => {
    expect(advanceStartPage(1, 1)).toBe(2);
    expect(advanceStartPage(10, 5)).toBe(15);
  });

  it('loops back to page 1 at the end', () => {
    expect(advanceStartPage(604, 1)).toBe(1);
    expect(advanceStartPage(603, 3)).toBe(2); // read 603,604,1 -> next is 2
    expect(advanceStartPage(600, 20)).toBe(16); // 600..604 (5) then 1..15 (15) -> next 16
  });
});

describe('nextPageAfter (channel admin "last page read")', () => {
  it('continues from the page after the one given', () => {
    expect(nextPageAfter(50)).toBe(51);
    expect(nextPageAfter(1)).toBe(2);
  });

  it('wraps 604 back to 1', () => {
    expect(nextPageAfter(604)).toBe(1);
  });

  it('rejects out-of-range input', () => {
    expect(() => nextPageAfter(0)).toThrow();
    expect(() => nextPageAfter(605)).toThrow();
  });
});

describe('khatmaDays', () => {
  it('estimates days to finish the whole Quran at a given pace', () => {
    expect(khatmaDays(1)).toBe(604);
    expect(khatmaDays(20)).toBe(31); // ceil(604/20)
    expect(khatmaDays(2)).toBe(302);
  });
});
