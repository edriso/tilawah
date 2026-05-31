// Small pure parsers for command arguments. Kept apart from bot.ts so they
// can be unit-tested without loading grammY or the database client. Every
// parser returns the validated value or null, and never throws on bad input.

import { toAsciiDigits, MIN_WIRD_PAGES, MAX_WIRD_PAGES, isValidPage } from '../core';

/**
 * Parse "HH:MM" (24-hour) into hour/minute, or null if invalid. Arabic-Indic
 * and Persian digits are accepted (the bot shows times in Arabic-Indic, so
 * users naturally type them back).
 */
export function parseTime(raw: string): { hour: number; minute: number } | null {
  const m = toAsciiDigits(raw.trim()).match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

/** True if a string is a timezone that Intl accepts. */
export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Parse a wird size: a whole number of pages from 1 to 20 (MAX_WIRD_PAGES).
 * Returns null on anything else, so the caller keeps the old value and shows
 * an error. Only a plain 1-2 digit number passes (no hex, sign, or exponent
 * sneaking through Number()).
 */
export function parseWirdSize(raw: string): number | null {
  const normalized = toAsciiDigits(raw.trim());
  if (!/^\d{1,2}$/.test(normalized)) return null;
  const n = Number(normalized);
  if (n < MIN_WIRD_PAGES || n > MAX_WIRD_PAGES) return null;
  return n;
}

/**
 * Parse a Mushaf page number: a whole number from 1 to 604. Returns null on
 * anything else. Used by the channel admin "last page read" command.
 */
export function parsePageNumber(raw: string): number | null {
  const normalized = toAsciiDigits(raw.trim());
  if (!/^\d{1,3}$/.test(normalized)) return null;
  const n = Number(normalized);
  return isValidPage(n) ? n : null;
}

/**
 * Parse the argument of the admin "/admin_preview" command: a Mushaf page to
 * render, plus an optional page count, for testing what the bot would send.
 *
 *   "10"     -> { page: 10, pages: 1 }
 *   "10 3"   -> { page: 10, pages: 3 }
 *
 * The page must be 1..604 and the count a valid wird size (1..20). Returns
 * null on anything malformed. Arabic-Indic digits are accepted.
 */
export function parsePagePreview(raw: string): { page: number; pages: number } | null {
  const parts = toAsciiDigits(raw.trim()).split(/\s+/).filter(Boolean);
  if (parts.length < 1 || parts.length > 2) return null;

  const page = parsePageNumber(parts[0]!);
  if (page === null) return null;

  let pages = 1;
  if (parts.length === 2) {
    const size = parseWirdSize(parts[1]!);
    if (size === null) return null;
    pages = size;
  }
  return { page, pages };
}
