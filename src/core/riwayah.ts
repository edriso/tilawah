// The riwayat (transmissions of the Quran) a wird can be delivered in. This is
// pure reference data: a stable `key` stored on the subscriber and on each
// seeded Ayah/asset, the Arabic display name, the route note, and the riwayah's
// counting school + total ayat (its عدّ الآي). No database, no network, so it is
// trivially testable.
//
// Hafs is the default; Warsh and Qaloon are added as their own VERIFIED text +
// page map + page images + page audio land (see docs/RIWAYAT.md). This registry
// just NAMES a riwayah and its invariant facts; whether one is actually OFFERED
// to a reader is gated separately on its data being fully seeded (the
// per-riwayah seed guard), exactly the way a reciter key can exist before its
// audio set is built. A riwayah may have NO reciter yet (text + image only); the
// audio resolver simply skips audio for it (see reciter.ts / pageAudioSourceFor).

/** The riwayah keys the bot knows. Stored as a short string on the subscriber
 *  and on each Ayah/asset (no Prisma enum), matching the rest of the schema. */
export type RiwayahKey = 'hafs' | 'warsh-asbahani' | 'qaloon';

export interface Riwayah {
  key: RiwayahKey;
  /** Arabic display name, e.g. "حفص عن عاصم". */
  nameAr: string;
  /** The route (طريق) note shown after the name, when one distinguishes this
   *  transmission from its siblings, e.g. "من طريق الأصبهاني" for this Warsh. */
  routeAr?: string;
  /** Total ayat in this riwayah's counting school. Hafs (Kufic) = 6236; Warsh
   *  and Qaloon (Madani) = 6214. The per-riwayah seed guard checks against this. */
  ayahCount: number;
  /** The عدّ الآي (verse-counting school). Hafs follows the Kufic count, Warsh
   *  and Qaloon the Madani. It is why their ayah totals differ and why anything
   *  keyed to Kufic numbering (a future tafseer) is off for non-Kufic riwayat. */
  countingSchool: 'kufi' | 'madani';
}

// Insertion order = display order in the picker (default first).
export const RIWAYAT: Record<RiwayahKey, Riwayah> = {
  hafs: { key: 'hafs', nameAr: 'حفص عن عاصم', ayahCount: 6236, countingSchool: 'kufi' },
  'warsh-asbahani': {
    key: 'warsh-asbahani',
    nameAr: 'ورش عن نافع',
    routeAr: 'من طريق الأصبهاني',
    ayahCount: 6214,
    countingSchool: 'madani',
  },
  // Qaloon عن نافع shares the Madani count (6214) with Warsh. No route note: the
  // KFGQPC Qaloon Madani mushaf (the seeded edition) is the common reference, so
  // "قالون عن نافع" is the label readers expect.
  qaloon: { key: 'qaloon', nameAr: 'قالون عن نافع', ayahCount: 6214, countingSchool: 'madani' },
};

/** The riwayah keys in display order (default first). */
export const RIWAYAH_KEYS = Object.keys(RIWAYAT) as RiwayahKey[];

/** The riwayah a brand-new subscriber and the channel get, and the schema
 *  default. Hafs: the riwayah the seeded text and every shipped reciter use. */
export const DEFAULT_RIWAYAH: RiwayahKey = 'hafs';

/** True when `value` is a known riwayah key. */
export function isRiwayah(value: unknown): value is RiwayahKey {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(RIWAYAT, value);
}

/** Coerce a stored/raw value into a valid riwayah key, defaulting safely. */
export function normalizeRiwayah(raw: unknown): RiwayahKey {
  return isRiwayah(raw) ? raw : DEFAULT_RIWAYAH;
}

/** The full Arabic label for a riwayah: the name plus its route note when it has
 *  one, e.g. "ورش عن نافع (من طريق الأصبهاني)". */
export function riwayahLabel(key: RiwayahKey): string {
  const r = RIWAYAT[key];
  return r.routeAr ? `${r.nameAr} (${r.routeAr})` : r.nameAr;
}
