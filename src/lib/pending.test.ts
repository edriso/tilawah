import { describe, it, expect, beforeEach } from 'vitest';
import { setPending, takePending, clearPending, sweepPending, pendingSize } from './pending';

const TTL = 5 * 60 * 1000;
// The store is module-global; a sweep far in the future clears everything.
const reset = () => sweepPending(Number.MAX_SAFE_INTEGER);

describe('pending input state', () => {
  beforeEach(reset);

  it('returns null when nothing is pending', () => {
    expect(takePending(1)).toBeNull();
  });

  it('stores then consumes a kind, leaving nothing behind', () => {
    setPending(1, 'page');
    expect(takePending(1)).toBe('page');
    expect(takePending(1)).toBeNull(); // already consumed
  });

  it('keeps each user separate (page vs wird)', () => {
    setPending(1, 'page');
    setPending(2, 'wird');
    expect(takePending(2)).toBe('wird');
    expect(takePending(1)).toBe('page');
  });

  it('lets the latest set win', () => {
    setPending(1, 'page', 0);
    setPending(1, 'wird', 0);
    expect(takePending(1, 0)).toBe('wird');
  });

  it('honours the TTL exactly', () => {
    setPending(1, 'page', 0);
    expect(takePending(1, TTL)).toBe('page'); // at the boundary, still valid
    setPending(1, 'page', 0);
    expect(takePending(1, TTL + 1)).toBeNull(); // one ms past is gone
  });

  it('clearPending drops without consuming', () => {
    setPending(1, 'wird');
    clearPending(1);
    expect(takePending(1)).toBeNull();
  });

  it('sweep removes only entries older than the TTL', () => {
    setPending(1, 'page', 0); // old
    setPending(2, 'wird', TTL + 1000); // recent
    sweepPending(TTL + 1001);
    expect(pendingSize()).toBe(1);
    expect(takePending(2, TTL + 1001)).toBe('wird');
  });
});
