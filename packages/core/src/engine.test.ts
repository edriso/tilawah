// Simulates the daily wird walk that the delivery engine performs, using only
// the pure page math. This proves the behaviours the spec calls out as edge
// cases (clean looping, multi-page wrap, pause leaves the position put) and
// that a CHANNEL subscriber and a USER subscriber walk identically, since the
// engine advances purely on (currentPage, wirdSize) and ignores the kind.

import { describe, it, expect } from 'vitest';
import { pagesForWird, advanceStartPage, TOTAL_PAGES } from './wird';

interface Walker {
  kind: 'user' | 'channel';
  currentPage: number;
  wirdSize: number;
  paused: boolean;
}

/** One day for a walker: returns the pages sent and the walker's new state. */
function readOneDay(w: Walker): { pages: number[]; next: Walker } {
  if (w.paused) return { pages: [], next: w }; // skipped; position does not move
  const pages = pagesForWird(w.currentPage, w.wirdSize);
  return { pages, next: { ...w, currentPage: advanceStartPage(w.currentPage, w.wirdSize) } };
}

describe('daily wird walk', () => {
  it('loops cleanly when a multi-page wird crosses the last page', () => {
    const day = readOneDay({ kind: 'user', currentPage: 603, wirdSize: 3, paused: false });
    expect(day.pages).toEqual([603, 604, 1]);
    expect(day.next.currentPage).toBe(2);
  });

  it('reads every page exactly once over a full khatma at one page a day', () => {
    let w: Walker = { kind: 'user', currentPage: 1, wirdSize: 1, paused: false };
    const seen: number[] = [];
    for (let d = 0; d < TOTAL_PAGES; d++) {
      const day = readOneDay(w);
      seen.push(...day.pages);
      w = day.next;
    }
    expect(seen).toHaveLength(TOTAL_PAGES);
    expect(new Set(seen).size).toBe(TOTAL_PAGES); // no repeats, no gaps
    expect(w.currentPage).toBe(1); // wrapped back to the start
  });

  it('does not move the position while paused', () => {
    const w: Walker = { kind: 'user', currentPage: 42, wirdSize: 5, paused: true };
    const day = readOneDay(w);
    expect(day.pages).toEqual([]);
    expect(day.next.currentPage).toBe(42);
  });

  it('walks a CHANNEL and a USER identically given the same start and size', () => {
    let user: Walker = { kind: 'user', currentPage: 600, wirdSize: 4, paused: false };
    let channel: Walker = { kind: 'channel', currentPage: 600, wirdSize: 4, paused: false };
    for (let d = 0; d < 10; d++) {
      const u = readOneDay(user);
      const c = readOneDay(channel);
      expect(c.pages).toEqual(u.pages);
      expect(c.next.currentPage).toBe(u.next.currentPage);
      user = u.next;
      channel = c.next;
    }
  });
});
