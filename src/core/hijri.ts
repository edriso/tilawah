/**
 * The Hijri (Islamic) date of the instant `now`, AS SEEN in `timezone`, written
 * in Arabic, for example "١٤ محرم ١٤٤٨ هـ".
 *
 * It uses the Umm al-Qura calendar, the civil Hijri calendar of Saudi Arabia and
 * the common reference for most readers. The timezone matters: at one instant a
 * reader far to the east can already be on the next day while one to the west is
 * still on the day before, so we format the instant in the reader's own zone,
 * exactly like getLocalContext does for the Gregorian day. Pure: it takes `now`,
 * so it has no hidden clock and is easy to test.
 */
export function hijriDate(timezone: string, now: Date): string {
  return new Intl.DateTimeFormat('ar-SA', {
    calendar: 'islamic-umalqura',
    timeZone: timezone,
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(now);
}
