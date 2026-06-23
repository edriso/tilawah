import { describe, it, expect } from 'vitest';
import {
  RIWAYAT,
  RIWAYAH_KEYS,
  DEFAULT_RIWAYAH,
  isRiwayah,
  normalizeRiwayah,
  riwayahLabel,
} from './riwayah';

describe('riwayah reference', () => {
  it('has the default first and every entry self-consistent', () => {
    expect(RIWAYAH_KEYS[0]).toBe(DEFAULT_RIWAYAH);
    expect(DEFAULT_RIWAYAH).toBe('hafs');
    for (const key of RIWAYAH_KEYS) {
      const r = RIWAYAT[key];
      expect(r.key).toBe(key); // the map key matches the row's own key
      expect(r.nameAr.trim()).not.toBe('');
      expect(r.ayahCount).toBeGreaterThan(0);
      expect(['kufi', 'madani']).toContain(r.countingSchool);
    }
  });

  it('encodes the verified counting facts (Kufic 6236 vs Madani 6214)', () => {
    expect(RIWAYAT.hafs).toMatchObject({ ayahCount: 6236, countingSchool: 'kufi' });
    expect(RIWAYAT['warsh-asbahani']).toMatchObject({ ayahCount: 6214, countingSchool: 'madani' });
  });

  it('validates and normalizes keys', () => {
    expect(isRiwayah('hafs')).toBe(true);
    expect(isRiwayah('warsh-asbahani')).toBe(true);
    expect(isRiwayah('nope')).toBe(false);
    expect(isRiwayah(undefined)).toBe(false);
    expect(normalizeRiwayah('warsh-asbahani')).toBe('warsh-asbahani');
    expect(normalizeRiwayah('garbage')).toBe(DEFAULT_RIWAYAH);
  });

  it('labels a riwayah with its route note only when it has one', () => {
    expect(riwayahLabel('hafs')).toBe('حفص عن عاصم');
    expect(riwayahLabel('warsh-asbahani')).toBe('ورش عن نافع (من طريق الأصبهاني)');
  });
});
