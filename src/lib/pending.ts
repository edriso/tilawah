// Short-lived per-user "which number am I waiting for" state. The bot is
// otherwise stateless, but after "/page" or "/wird" with no argument the user
// may reply with just a number; we remember which setting that number is for.
// In-memory and single-process; a restart drops it (the user re-runs the
// command). The page (1-604) and wird (1-20) ranges overlap, so we genuinely
// need this to know what a bare number means.
//
// Entries are cleared three ways: consumed by takePending, dropped when the
// user does anything else (the bot clears on any command or button tap), and
// swept on a timer so an abandoned prompt never leaks memory. `now` is
// injectable so the logic is unit-testable without touching the real clock.

export type PendingKind = 'page' | 'wird';

const TTL_MS = 5 * 60 * 1000;
const store = new Map<number, { kind: PendingKind; at: number }>();

/** Arm: the user's next plain number answers this setting. */
export function setPending(userId: number, kind: PendingKind, now: number = Date.now()): void {
  store.set(userId, { kind, at: now });
}

/** Disarm without consuming (e.g. the user used a button or another command). */
export function clearPending(userId: number): void {
  store.delete(userId);
}

/** Read and clear a user's pending kind, or null if none or expired. */
export function takePending(userId: number, now: number = Date.now()): PendingKind | null {
  const entry = store.get(userId);
  if (!entry) return null;
  store.delete(userId);
  return now - entry.at > TTL_MS ? null : entry.kind;
}

/** Drop entries older than the TTL so abandoned prompts never leak memory. */
export function sweepPending(now: number = Date.now()): void {
  for (const [id, entry] of store) {
    if (now - entry.at > TTL_MS) store.delete(id);
  }
}

/** Number of stored entries (for tests). */
export function pendingSize(): number {
  return store.size;
}
