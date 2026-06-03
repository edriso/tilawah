import { describe, it, expect } from 'vitest';
import {
  isWirdFormat,
  normalizeWirdFormat,
  hasPagePlaceholder,
  isHttpSource,
  mushafImageSource,
  WIRD_FORMAT_TEXT,
  WIRD_FORMAT_IMAGE,
} from './mushaf-image';

describe('wird format helpers', () => {
  it('recognises the two known formats and nothing else', () => {
    expect(isWirdFormat('text')).toBe(true);
    expect(isWirdFormat('image')).toBe(true);
    expect(isWirdFormat('audio')).toBe(false);
    expect(isWirdFormat(undefined)).toBe(false);
    expect(isWirdFormat(null)).toBe(false);
  });

  it('normalizes a known value through unchanged', () => {
    expect(normalizeWirdFormat('image')).toBe(WIRD_FORMAT_IMAGE);
    expect(normalizeWirdFormat('text')).toBe(WIRD_FORMAT_TEXT);
  });

  it('falls back to text on an unknown or missing value', () => {
    expect(normalizeWirdFormat('nope')).toBe('text');
    expect(normalizeWirdFormat(undefined)).toBe('text');
    expect(normalizeWirdFormat(null)).toBe('text');
  });

  it('honours an explicit fallback', () => {
    expect(normalizeWirdFormat('nope', WIRD_FORMAT_IMAGE)).toBe('image');
  });
});

describe('hasPagePlaceholder', () => {
  it('is true for {page} or {page3}', () => {
    expect(hasPagePlaceholder('https://x/{page}.png')).toBe(true);
    expect(hasPagePlaceholder('https://x/{page3}.png')).toBe(true);
  });
  it('is false with no placeholder', () => {
    expect(hasPagePlaceholder('https://x/page.png')).toBe(false);
    expect(hasPagePlaceholder('https://x/{pg}.png')).toBe(false);
  });
});

describe('isHttpSource', () => {
  it('is true for http(s) URLs', () => {
    expect(isHttpSource('https://x/1.png')).toBe(true);
    expect(isHttpSource('http://x/1.png')).toBe(true);
    expect(isHttpSource('HTTPS://X/1.PNG')).toBe(true);
  });
  it('is false for local filesystem paths', () => {
    expect(isHttpSource('/app/assets/mushaf/001.jpg')).toBe(false);
    expect(isHttpSource('assets/mushaf/001.jpg')).toBe(false);
    expect(isHttpSource('./mushaf/1.jpg')).toBe(false);
  });
});

describe('mushafImageSource', () => {
  it('substitutes {page} with the raw number', () => {
    expect(mushafImageSource('https://x/{page}.png', 25)).toBe('https://x/25.png');
    expect(mushafImageSource('https://x/{page}.png', 604)).toBe('https://x/604.png');
  });

  it('substitutes {page3} zero-padded to three digits', () => {
    expect(mushafImageSource('https://x/{page3}.png', 1)).toBe('https://x/001.png');
    expect(mushafImageSource('https://x/{page3}.png', 25)).toBe('https://x/025.png');
    expect(mushafImageSource('https://x/{page3}.png', 604)).toBe('https://x/604.png');
  });

  it('works for a local path template too', () => {
    expect(mushafImageSource('/app/assets/mushaf/{page3}.jpg', 5)).toBe(
      '/app/assets/mushaf/005.jpg',
    );
  });

  it('substitutes every occurrence', () => {
    expect(mushafImageSource('https://x/{page3}/p{page}.png', 7)).toBe('https://x/007/p7.png');
  });

  it('throws on a page outside 1..604', () => {
    expect(() => mushafImageSource('https://x/{page}.png', 0)).toThrow();
    expect(() => mushafImageSource('https://x/{page}.png', 605)).toThrow();
    expect(() => mushafImageSource('https://x/{page}.png', 1.5)).toThrow();
  });

  it('throws when the template has no placeholder', () => {
    expect(() => mushafImageSource('https://x/page.png', 10)).toThrow(/placeholder/);
  });
});
