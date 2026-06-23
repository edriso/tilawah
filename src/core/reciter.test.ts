import { describe, it, expect } from 'vitest';
import {
  RECITERS,
  RECITER_KEYS,
  DEFAULT_RECITER,
  isReciter,
  normalizeReciter,
  recitersForRiwayah,
  defaultReciterForRiwayah,
  reciterForRiwayah,
  pageAudioSource,
} from './reciter';

describe('reciter reference', () => {
  it('has the default first and every key mapped to a folder + riwayah', () => {
    expect(RECITER_KEYS[0]).toBe(DEFAULT_RECITER);
    expect(DEFAULT_RECITER).toBe('abdulbasit');
    for (const key of RECITER_KEYS) {
      expect(RECITERS[key].folder.length).toBeGreaterThan(0);
      expect(RECITERS[key].riwayah.length).toBeGreaterThan(0);
    }
  });

  it('validates and normalizes keys', () => {
    expect(isReciter('husary')).toBe(true);
    expect(isReciter('nope')).toBe(false);
    expect(isReciter(undefined)).toBe(false);
    expect(normalizeReciter('alafasy')).toBe('alafasy');
    expect(normalizeReciter('garbage')).toBe(DEFAULT_RECITER);
  });
});

describe('reciter-by-riwayah', () => {
  it("lists only a riwayah's reciters, and the default belongs to it", () => {
    const hafs = recitersForRiwayah('hafs');
    expect(hafs.length).toBeGreaterThan(0);
    expect(hafs).toContain('abdulbasit');
    for (const key of hafs) expect(RECITERS[key].riwayah).toBe('hafs');
    expect(defaultReciterForRiwayah('hafs')).toBe(DEFAULT_RECITER);
    expect(hafs).toContain(defaultReciterForRiwayah('hafs'));
  });

  it('keeps a matching reciter and falls back when it does not match the riwayah', () => {
    // A Hafs reciter on the Hafs riwayah is kept.
    expect(reciterForRiwayah('husary', 'hafs')).toBe('husary');
    // Garbage falls back to the riwayah default.
    expect(reciterForRiwayah('garbage', 'hafs')).toBe(defaultReciterForRiwayah('hafs'));
  });
});

describe('pageAudioSource', () => {
  it('builds the everyayah per-page URL, page zero-padded to 3 digits', () => {
    expect(pageAudioSource('abdulbasit', 1)).toBe(
      'https://everyayah.com/data/Abdul_Basit_Murattal_192kbps/PageMp3s/Page001.mp3',
    );
    expect(pageAudioSource('husary', 604)).toBe(
      'https://everyayah.com/data/Husary_128kbps/PageMp3s/Page604.mp3',
    );
  });

  it('honours a custom template (for a self-hosted set)', () => {
    expect(pageAudioSource('husary', 5, '/audio/{folder}/{page3}.mp3')).toBe(
      '/audio/Husary_128kbps/005.mp3',
    );
  });

  it('throws on an out-of-range page', () => {
    expect(() => pageAudioSource('husary', 0)).toThrow();
    expect(() => pageAudioSource('husary', 605)).toThrow();
  });
});
