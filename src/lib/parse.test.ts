import { describe, it, expect } from 'vitest';
import { parseTime, isValidTimezone, parseWirdSize, parsePageNumber } from './parse';

describe('parseTime', () => {
  it('parses normal and single-digit-hour times', () => {
    expect(parseTime('07:00')).toEqual({ hour: 7, minute: 0 });
    expect(parseTime('23:59')).toEqual({ hour: 23, minute: 59 });
    expect(parseTime('7:05')).toEqual({ hour: 7, minute: 5 });
  });

  it('accepts Arabic-Indic digits', () => {
    expect(parseTime('٠٧:٠٠')).toEqual({ hour: 7, minute: 0 });
  });

  it('rejects out-of-range and malformed input', () => {
    expect(parseTime('24:00')).toBeNull();
    expect(parseTime('07:60')).toBeNull();
    expect(parseTime('7')).toBeNull();
    expect(parseTime('abc')).toBeNull();
  });
});

describe('isValidTimezone', () => {
  it('accepts real IANA names and rejects nonsense', () => {
    expect(isValidTimezone('Africa/Cairo')).toBe(true);
    expect(isValidTimezone('Asia/Riyadh')).toBe(true);
    expect(isValidTimezone('not-a-zone')).toBe(false);
  });
});

describe('parseWirdSize', () => {
  it('accepts whole numbers from 1 to 20', () => {
    expect(parseWirdSize('1')).toBe(1);
    expect(parseWirdSize('20')).toBe(20);
    expect(parseWirdSize('٥')).toBe(5); // Arabic-Indic
  });

  it('rejects out-of-range, zero, and junk', () => {
    expect(parseWirdSize('0')).toBeNull();
    expect(parseWirdSize('21')).toBeNull();
    expect(parseWirdSize('100')).toBeNull();
    expect(parseWirdSize('-3')).toBeNull();
    expect(parseWirdSize('abc')).toBeNull();
    expect(parseWirdSize('')).toBeNull();
  });
});

describe('parsePageNumber', () => {
  it('accepts whole page numbers from 1 to 604', () => {
    expect(parsePageNumber('1')).toBe(1);
    expect(parsePageNumber('50')).toBe(50);
    expect(parsePageNumber('604')).toBe(604);
    expect(parsePageNumber('٦٠٤')).toBe(604); // Arabic-Indic
  });

  it('rejects out-of-range and junk', () => {
    expect(parsePageNumber('0')).toBeNull();
    expect(parsePageNumber('605')).toBeNull();
    expect(parsePageNumber('9999')).toBeNull();
    expect(parsePageNumber('12a')).toBeNull();
    expect(parsePageNumber('')).toBeNull();
  });
});
