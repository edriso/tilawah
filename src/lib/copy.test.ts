import { describe, it, expect } from 'vitest';
import { ALL_DAYS, NO_DAYS, maskFromDays } from '../core';
import {
  wirdSizeSummaryAr,
  daysCountAr,
  daysSummaryAr,
  formatTimeAr,
  pagePositionAr,
  settingsSummary,
  ltr,
  COPY,
} from './copy';

describe('formatTimeAr', () => {
  it('pads to two digits with Arabic-Indic digits', () => {
    expect(formatTimeAr(7, 0)).toBe('٠٧:٠٠');
    expect(formatTimeAr(23, 59)).toBe('٢٣:٥٩');
  });
});

describe('wirdSizeSummaryAr (Arabic number-noun agreement)', () => {
  it('uses the right form for 1, 2, 3-10, and 11+', () => {
    expect(wirdSizeSummaryAr(1)).toBe('صفحة واحدة');
    expect(wirdSizeSummaryAr(2)).toBe('صفحتان');
    expect(wirdSizeSummaryAr(5)).toBe('٥ صفحات');
    expect(wirdSizeSummaryAr(10)).toBe('١٠ صفحات');
    expect(wirdSizeSummaryAr(15)).toBe('١٥ صفحة');
    expect(wirdSizeSummaryAr(20)).toBe('٢٠ صفحة');
  });
});

describe('daysCountAr (Arabic number-noun agreement for days)', () => {
  it('uses the right form for 1, 2, 3-10, and 11+', () => {
    expect(daysCountAr(1)).toBe('يوم واحد');
    expect(daysCountAr(2)).toBe('يومين');
    expect(daysCountAr(3)).toBe('٣ أيام');
    expect(daysCountAr(11)).toBe('١١ يومًا');
  });
});

describe('bot profile fits Telegram limits', () => {
  // Telegram rejects an over-long short description (120) or description (512)
  // with a 400, and setBotProfile awaits both un-caught at boot — so an
  // over-long string crash-loops the bot and the live text silently goes stale.
  // Count Unicode code points, the way Telegram counts characters.
  it('botAbout is within the 120-character short-description limit', () => {
    expect([...COPY.botAbout].length).toBeLessThanOrEqual(120);
  });

  it('botDescription is within the 512-character description limit', () => {
    expect([...COPY.botDescription].length).toBeLessThanOrEqual(512);
  });
});

describe('read-confirmation copy', () => {
  it('confirmed message names the new page (and juz) and points to /next', () => {
    const msg = COPY.readConfirmed(15, 1);
    expect(msg).toContain('صفحة ١٥ (الجزء ١)');
    expect(msg).toContain('/next');
  });

  it('missed-days message states the days and embeds the ayah + reference', () => {
    const msg = COPY.missedDaysMessage(3, {
      text: 'نص الآية',
      surahNameAr: 'فاطر',
      numberInSurah: 29,
    });
    expect(msg).toContain('٣ أيام');
    expect(msg).toContain('نص الآية');
    expect(msg).toContain('سورة فاطر');
    expect(msg).toContain('٢٩');
    // The verse is framed as encouragement, so it is never mistaken for the
    // reader's own wird (which follows next under "🌿 وردك اليوم").
    expect(msg).toContain('وهذه آيةٌ في فضل القرآن:');
    expect(msg).not.toContain('وردك اليوم');
    // Re-engagement copy keeps agency on the reader (a fresh start) and never
    // says the Qur'an "waits" on them.
    expect(msg).toContain('كل يومٍ فرصةٌ جديدة');
    expect(msg).not.toContain('بانتظارك');
  });
});

describe('page copy (the /page command)', () => {
  it('prompt shows the current position and how to change it', () => {
    const msg = COPY.pagePrompt(2, 1);
    expect(msg).toContain('صفحة ٢ (الجزء ١)');
    expect(msg).toContain('١ إلى ٦٠٤');
    expect(msg).toContain('/page 100');
  });

  it('page-set message names the new position', () => {
    expect(COPY.pageSet(100, 5)).toContain('صفحة ١٠٠ (الجزء ٥)');
  });

  it('invalid message states the allowed range', () => {
    expect(COPY.pageInvalid).toContain('١ إلى ٦٠٤');
  });
});

describe('pagePositionAr', () => {
  it('shows the page and, when known, the juz', () => {
    expect(pagePositionAr(25, 2)).toBe('صفحة ٢٥ (الجزء ٢)');
    expect(pagePositionAr(25)).toBe('صفحة ٢٥');
  });
});

describe('daysSummaryAr (Saturday first)', () => {
  it('summarises all / none / some, Saturday first', () => {
    expect(daysSummaryAr(ALL_DAYS)).toBe('كل الأيام');
    expect(daysSummaryAr(NO_DAYS)).toContain('لا يوجد');
    expect(daysSummaryAr(maskFromDays([5]))).toBe('الجمعة');
    expect(daysSummaryAr(maskFromDays([1, 6]))).toBe('السبت، الإثنين');
  });
});

describe('ltr (bidi isolation)', () => {
  it('wraps a run in the isolate characters', () => {
    const open = String.fromCodePoint(0x2066);
    const close = String.fromCodePoint(0x2069);
    expect(ltr('/wird 5')).toBe(`${open}/wird 5${close}`);
  });
});

describe('settingsSummary', () => {
  const base = {
    deliveryHour: 6,
    deliveryMinute: 0,
    activeDays: ALL_DAYS,
    timezone: 'Africa/Cairo',
    wirdSize: 1,
    currentPage: 1,
    pausedAt: null as Date | null,
  };

  it('shows working, wird size, and position for an active user', () => {
    const s = settingsSummary(base);
    expect(s).toContain('يعمل');
    expect(s).toContain('صفحة واحدة');
    expect(s).toContain('صفحة ١');
  });

  it('shows the break state when paused', () => {
    expect(settingsSummary({ ...base, pausedAt: new Date() })).toContain('وضع الراحة');
  });

  it('warns when no day is chosen', () => {
    expect(settingsSummary({ ...base, activeDays: NO_DAYS })).toContain('لن يصلك ورد');
  });

  it('uses a channel heading and channel wording when asked', () => {
    const s = settingsSummary(base, { isChannel: true });
    expect(s).toContain('إعدادات القناة');
  });
});
