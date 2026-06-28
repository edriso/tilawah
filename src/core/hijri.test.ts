import { describe, it, expect } from 'vitest';
import { hijriDate } from './hijri';

describe('hijriDate', () => {
  it('formats the Hijri date in Arabic with the year and "هـ"', () => {
    // 2026-06-28 is 14 Muharram 1448 in Cairo (well clear of any midnight edge).
    const s = hijriDate('Africa/Cairo', new Date('2026-06-28T12:00:00Z'));
    expect(s).toContain('محرم');
    expect(s).toContain('١٤٤٨');
    expect(s).toContain('هـ'); // the Hijri-era marker
  });

  it('depends on the reader timezone at a day boundary', () => {
    // Late-evening UTC: zones east of UTC have already rolled to the next day,
    // while zones to the west are still on the day before, so the Hijri day
    // (its leading number) differs by one between them.
    const now = new Date('2026-06-28T22:30:00Z');
    const east = hijriDate('Pacific/Kiritimati', now); // UTC+14, next day
    const west = hijriDate('America/Los_Angeles', now); // UTC-7, previous day
    expect(east).not.toBe(west);
  });
});
