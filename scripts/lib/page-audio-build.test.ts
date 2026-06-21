import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildPageAyat, pad3, pageFileName, type QuranData } from './page-audio-build';

const quran = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../prisma/data/quran-uthmani.json', import.meta.url)),
    'utf8',
  ),
) as QuranData;

describe('pad3 / pageFileName', () => {
  it('pads to three digits and names the page file', () => {
    expect(pad3(1)).toBe('001');
    expect(pad3(11)).toBe('011');
    expect(pad3(604)).toBe('604');
    expect(pageFileName(11)).toBe('Page011.mp3');
  });
});

describe('buildPageAyat (from the seeded Quran data = the layout the wird uses)', () => {
  const map = buildPageAyat(quran);

  it('covers all 604 pages and all 6236 ayat', () => {
    expect(map.size).toBe(604);
    const total = [...map.values()].reduce((n, ayat) => n + ayat.length, 0);
    expect(total).toBe(6236);
  });

  it('puts the right ayat on page 11 (2:70..2:76) — the page everyayah got wrong', () => {
    const p11 = map.get(11)!;
    expect(p11[0]).toEqual({ surah: 2, ayah: 70 });
    expect(p11[p11.length - 1]).toEqual({ surah: 2, ayah: 76 });
    expect(p11).toHaveLength(7);
  });

  it('page 1 is Al-Fatihah 1..7 and page 604 opens with Al-Ikhlas', () => {
    const p1 = map.get(1)!;
    expect(p1[0]).toEqual({ surah: 1, ayah: 1 });
    expect(p1[p1.length - 1]).toEqual({ surah: 1, ayah: 7 });
    expect(map.get(604)![0]).toEqual({ surah: 112, ayah: 1 });
  });
});
