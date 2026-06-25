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
    // Both Warsh turuq share the Madani count (6214) and the same Warsh text.
    expect(RIWAYAT['warsh-azraq']).toMatchObject({ ayahCount: 6214, countingSchool: 'madani' });
    expect(RIWAYAT['warsh-asbahani']).toMatchObject({ ayahCount: 6214, countingSchool: 'madani' });
    // Qaloon shares the Madani count (6214) with Warsh.
    expect(RIWAYAT.qaloon).toMatchObject({ ayahCount: 6214, countingSchool: 'madani' });
  });

  it('validates and normalizes keys', () => {
    expect(isRiwayah('hafs')).toBe(true);
    expect(isRiwayah('warsh-azraq')).toBe(true);
    expect(isRiwayah('warsh-asbahani')).toBe(true);
    expect(isRiwayah('qaloon')).toBe(true);
    expect(isRiwayah('nope')).toBe(false);
    expect(isRiwayah(undefined)).toBe(false);
    expect(normalizeRiwayah('warsh-azraq')).toBe('warsh-azraq');
    expect(normalizeRiwayah('warsh-asbahani')).toBe('warsh-asbahani');
    expect(normalizeRiwayah('qaloon')).toBe('qaloon');
    expect(normalizeRiwayah('garbage')).toBe(DEFAULT_RIWAYAH);
  });

  it('labels a riwayah with its route note only when it has one', () => {
    expect(riwayahLabel('hafs')).toBe('حفص عن عاصم');
    // The two Warsh turuq share the name but differ by route note.
    expect(riwayahLabel('warsh-azraq')).toBe('ورش عن نافع (من طريق الأزرق)');
    expect(riwayahLabel('warsh-asbahani')).toBe('ورش عن نافع (من طريق الأصبهاني)');
    // Qaloon has no route note, so just the name.
    expect(riwayahLabel('qaloon')).toBe('قالون عن نافع');
  });
});
