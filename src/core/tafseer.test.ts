import { describe, it, expect } from 'vitest';
import { pageTafseerUrl } from './tafseer';

describe('pageTafseerUrl', () => {
  it('builds the Arabic quran.com page URL', () => {
    expect(pageTafseerUrl(1)).toBe('https://quran.com/ar/page/1');
    expect(pageTafseerUrl(604)).toBe('https://quran.com/ar/page/604');
  });
});
