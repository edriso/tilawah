import { describe, it, expect } from 'vitest';
import { SURAHS } from './surahs';
import { AYAH_COUNTS, TOTAL_AYAT, ayahCountFor } from './ayah-counts';
import { PAGE_COUNT, JUZ_COUNT, PAGE_ANCHORS, JUZ_ANCHORS } from './pages';

describe('surah reference table', () => {
  it('has all 114 surahs', () => {
    expect(SURAHS).toHaveLength(114);
  });

  it('numbers them 1..114 with no gaps or duplicates', () => {
    const numbers = SURAHS.map((s) => s.number);
    expect(numbers).toEqual(Array.from({ length: 114 }, (_, i) => i + 1));
  });

  it('gives every surah a name and a valid revelation place', () => {
    for (const s of SURAHS) {
      expect(s.nameAr.length).toBeGreaterThan(0);
      expect(s.nameEn.length).toBeGreaterThan(0);
      expect(['meccan', 'medinan']).toContain(s.revelation);
    }
  });
});

describe('ayah counts oracle', () => {
  it('covers surahs 1..114 (index 0 is the unused placeholder)', () => {
    expect(AYAH_COUNTS).toHaveLength(115);
  });

  it('sums to exactly 6236 ayat', () => {
    const sum = AYAH_COUNTS.reduce((a, b) => a + b, 0);
    expect(sum).toBe(TOTAL_AYAT);
    expect(sum).toBe(6236);
  });

  it('matches well-known anchor counts', () => {
    expect(ayahCountFor(1)).toBe(7); // Al-Fatihah
    expect(ayahCountFor(2)).toBe(286); // Al-Baqarah (longest)
    expect(ayahCountFor(114)).toBe(6); // An-Nas
  });
});

describe('Madani Mushaf page/juz constants', () => {
  it('is 604 pages and 30 juz', () => {
    expect(PAGE_COUNT).toBe(604);
    expect(JUZ_COUNT).toBe(30);
  });

  it('keeps the standard layout anchors', () => {
    expect(PAGE_ANCHORS).toContainEqual({ page: 1, surah: 1, ayah: 1 });
    expect(PAGE_ANCHORS).toContainEqual({ page: 2, surah: 2, ayah: 1 });
    expect(PAGE_ANCHORS).toContainEqual({ page: 604, surah: 112, ayah: 1 });
    expect(JUZ_ANCHORS).toContainEqual({ juz: 1, surah: 1, ayah: 1 });
    expect(JUZ_ANCHORS).toContainEqual({ juz: 30, surah: 78, ayah: 1 });
  });
});
