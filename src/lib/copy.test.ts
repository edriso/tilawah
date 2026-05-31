import { describe, it, expect } from 'vitest';
import { ALL_DAYS, NO_DAYS, maskFromDays } from '../core';
import {
  wirdSizeSummaryAr,
  daysSummaryAr,
  formatTimeAr,
  pagePositionAr,
  settingsSummary,
  ltr,
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
