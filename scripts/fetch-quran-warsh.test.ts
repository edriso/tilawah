import { describe, it, expect } from 'vitest';
import { stripAyahNumber, firstInt } from './fetch-quran-warsh';

describe('stripAyahNumber', () => {
  it('removes the trailing ayah-number glyph and trims both ends', () => {
    expect(stripAyahNumber('اِ۬لْحَمْدُ لِلهِ رَبِّ اِ۬لْعَٰلَمِينَ ١')).toBe(
      'اِ۬لْحَمْدُ لِلهِ رَبِّ اِ۬لْعَٰلَمِينَ',
    );
    // multi-digit marker, and a leading space (as seen at 114:6)
    expect(stripAyahNumber(' مِنَ اَ۬لْجِنَّةِ وَالنَّاسِۖ ٢٨٦')).toBe('مِنَ اَ۬لْجِنَّةِ وَالنَّاسِۖ');
  });

  it('leaves real text untouched (no trailing digits)', () => {
    expect(stripAyahNumber('قُلْ هُوَ اَ۬للَّهُ أَحَدٌ')).toBe('قُلْ هُوَ اَ۬للَّهُ أَحَدٌ');
  });
});

describe('firstInt', () => {
  it('reads a plain number or numeric string', () => {
    expect(firstInt(1)).toBe(1);
    expect(firstInt('187')).toBe(187);
  });

  it('takes the START page of a page-spanning range like "85-86"', () => {
    expect(firstInt('85-86')).toBe(85);
  });

  it('is NaN when there is no digit (so the caller rejects it)', () => {
    expect(Number.isNaN(firstInt('-'))).toBe(true);
  });
});
