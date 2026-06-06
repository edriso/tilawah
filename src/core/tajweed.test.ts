import { describe, it, expect } from 'vitest';
import {
  nextLessonIndex,
  lessonIndexInRange,
  formatLesson,
  hasAyahPlaceholder,
  tajweedAudioSource,
  type TajweedLesson,
  type LessonExample,
} from './tajweed';

describe('nextLessonIndex (cycles the deck)', () => {
  it('advances by one in the middle', () => {
    expect(nextLessonIndex(0, 45)).toBe(1);
    expect(nextLessonIndex(10, 45)).toBe(11);
  });

  it('wraps back to 0 at the end (the deck repeats)', () => {
    expect(nextLessonIndex(44, 45)).toBe(0);
  });

  it('restarts at 0 from a null/garbage current', () => {
    expect(nextLessonIndex(-1, 45)).toBe(0);
    expect(nextLessonIndex(NaN, 45)).toBe(0);
  });

  it('rejects a non-positive total', () => {
    expect(() => nextLessonIndex(0, 0)).toThrow();
  });
});

describe('lessonIndexInRange', () => {
  it('keeps in-range values', () => {
    expect(lessonIndexInRange(3, 45)).toBe(3);
  });
  it('wraps an out-of-range index (deck shrank) and floors a bad one', () => {
    expect(lessonIndexInRange(50, 45)).toBe(5);
    expect(lessonIndexInRange(-1, 45)).toBe(0);
  });
});

describe('formatLesson', () => {
  const lesson: TajweedLesson = {
    titleAr: 'الإقلاب',
    bodyAr: 'إذا جاء بعد النون الساكنة باء قُلبت ميمًا.',
    example: { surah: 2, ayah: 27 },
    exampleNote: 'النون الساكنة قبل الباء.',
  };
  const example: LessonExample = { surahNameAr: 'البقرة', numberInSurah: 27, text: 'مِنۢ بَعْدِ' };

  it('includes the title, body, and the example ayah with its reference', () => {
    const msg = formatLesson(lesson, example);
    expect(msg).toContain('درس التجويد اليوم: الإقلاب');
    expect(msg).toContain('إذا جاء بعد النون الساكنة');
    expect(msg).toContain('مِنۢ بَعْدِ ﴿٢٧﴾'); // verified text + ornamented marker
    expect(msg).toContain('مثال من سورة البقرة'); // the surah named on the label line
    expect(msg).toContain('النون الساكنة قبل الباء.');
  });

  it('omits the note and link lines when absent', () => {
    const msg = formatLesson({ ...lesson, exampleNote: undefined }, example);
    expect(msg).not.toContain('النون الساكنة قبل الباء.');
    expect(msg).not.toContain('للاستزادة');
  });

  it('adds the learn-more link when present, isolated for bidi safety', () => {
    const msg = formatLesson({ ...lesson, moreUrl: 'https://x/y' }, example);
    expect(msg).toContain('للاستزادة');
    // The URL is wrapped in directional isolates (U+2066 … U+2069).
    expect(msg).toContain(`⁦https://x/y⁩`);
  });
});

describe('hasAyahPlaceholder', () => {
  it('needs both a surah and an ayah placeholder', () => {
    expect(hasAyahPlaceholder('https://x/{surah3}{ayah3}.mp3')).toBe(true);
    expect(hasAyahPlaceholder('https://x/{surah}/{ayah}.mp3')).toBe(true);
    expect(hasAyahPlaceholder('https://x/{surah3}.mp3')).toBe(false); // ayah missing
    expect(hasAyahPlaceholder('https://x/{page3}.jpg')).toBe(false);
  });
});

describe('tajweedAudioSource', () => {
  it('builds a zero-padded per-ayah source', () => {
    expect(tajweedAudioSource('https://x/{surah3}{ayah3}.mp3', 2, 27)).toBe('https://x/002027.mp3');
    expect(tajweedAudioSource('https://x/{surah}_{ayah}.mp3', 114, 6)).toBe('https://x/114_6.mp3');
  });

  it('throws on a bad surah/ayah or a template with no placeholder', () => {
    expect(() => tajweedAudioSource('https://x/{surah3}{ayah3}.mp3', 0, 1)).toThrow();
    expect(() => tajweedAudioSource('https://x/{surah3}{ayah3}.mp3', 2, 0)).toThrow();
    expect(() => tajweedAudioSource('https://x/no-placeholder.mp3', 2, 27)).toThrow();
  });
});
