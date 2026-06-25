// Pure helpers for the page-audio generator and verifier. No network, no
// ffmpeg, no filesystem, so the page->ayat math is unit-tested on its own.
//
// The whole point of the generator is correctness: a page clip must contain
// EXACTLY the ayat our Madani layout puts on that page (the same layout the wird
// text uses), built from the trusted per-ayah recitations. everyayah's pre-split
// PageMp3s do NOT guarantee this (e.g. Abdul Basit's Page011 drops 2:76), which
// is the whole reason we self-host a verified set.

/** One ayah's position: its surah and its number within that surah. */
export interface PageAyah {
  surah: number;
  ayah: number;
}

/** The shape of prisma/data/quran-uthmani.json that we read (ayat are ordered;
 *  the array index + 1 is the ayah's number within its surah). */
export interface QuranData {
  surahs: { number: number; ayat: { page: number }[] }[];
}

/**
 * Build `page -> ordered ayat` from the seeded Quran data. This is the single
 * source of truth for "which ayat are on page N", matching what the wird text
 * shows (both derive from the same data). The generator concatenates exactly
 * these ayat per page; the verifier checks against them.
 */
export function buildPageAyat(quran: QuranData): Map<number, PageAyah[]> {
  const map = new Map<number, PageAyah[]>();
  for (const surah of quran.surahs) {
    surah.ayat.forEach((a, i) => {
      const list = map.get(a.page);
      const entry: PageAyah = { surah: surah.number, ayah: i + 1 };
      if (list) list.push(entry);
      else map.set(a.page, [entry]);
    });
  }
  return map;
}

/** Zero-pad a number to 3 digits (1 -> "001", 11 -> "011", 604 -> "604"). */
export function pad3(n: number): string {
  return String(n).padStart(3, '0');
}

/** The file name for a page's clip in the self-hosted set: "Page011.mp3". This
 *  matches the {page3} the runtime template fills, so the bot finds the file. */
export function pageFileName(page: number): string {
  return `Page${pad3(page)}.mp3`;
}

// ─── MP3 header inspection: catching the everyayah Xing-header defect ──────────
//
// everyayah's pre-split PageMp3s for some reciters (Alafasy is fully affected)
// carry a stale Xing/Info header whose declared frame count is the FIRST ayah
// only, while the file actually holds the whole page. ffprobe SCANS frames, so
// it reports the real length and the clip looks fine; the verifier's byte-size
// check also passes (all bytes are present). But Telegram and most phone players
// TRUST the Xing header for duration and stop after the first ayah — the exact
// "page 383 plays only 27:64" bug. These pure helpers expose the header's claim
// and the file's real frame count so a check can flag the mismatch. No network,
// no ffmpeg: a Buffer in, numbers out, so the math is unit-tested on its own.

/** Samples per MP3 frame, by (version, layer). MPEG1 Layer 3 is 1152; the
 *  MPEG2/2.5 "low sample rate" extensions halve Layer 3 to 576. Layer 1 is 384,
 *  Layer 2 is 1152 for every version. */
function samplesPerFrame(mpegVersion: 1 | 2, layer: 1 | 2 | 3): number {
  if (layer === 1) return 384;
  if (layer === 2) return 1152;
  return mpegVersion === 1 ? 1152 : 576; // layer 3
}

// Bitrate tables in kbps (index 0 = "free", 15 = "bad"; both unusable here).
const BITRATES: Record<string, (number | null)[]> = {
  '1-1': [null, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448, null],
  '1-2': [null, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384, null],
  '1-3': [null, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, null],
  '2-1': [null, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256, null],
  '2-2': [null, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, null], // also 2-3
};
const SAMPLE_RATES: Record<number, number[]> = {
  3: [44100, 48000, 32000], // MPEG1
  2: [22050, 24000, 16000], // MPEG2
  0: [11025, 12000, 8000], // MPEG2.5
};

export interface Mp3Frame {
  /** 1 for MPEG1, 2 for the MPEG2 / MPEG2.5 low-rate family. */
  mpegVersion: 1 | 2;
  layer: 1 | 2 | 3;
  bitrateKbps: number;
  sampleRate: number;
  samplesPerFrame: number;
  /** Total frame length in bytes (header + payload + any padding). */
  frameLength: number;
}

/** Parse an MP3 frame header at `off`, or null when `off` is not a valid frame
 *  (no sync, reserved/free bitrate, bad sample rate). Layers 1-3 and MPEG 1/2/2.5
 *  are handled, which covers every everyayah recitation file. */
export function parseMp3FrameHeader(buf: Buffer, off: number): Mp3Frame | null {
  if (off + 4 > buf.length) return null;
  // 11-bit frame sync: first byte 0xFF, top 3 bits of the second byte set.
  if (buf[off] !== 0xff || (buf[off + 1] & 0xe0) !== 0xe0) return null;
  const versionBits = (buf[off + 1] >> 3) & 0x03; // 00=2.5, 10=2, 11=1 (01=reserved)
  const layerBits = (buf[off + 1] >> 1) & 0x03; // 01=L3, 10=L2, 11=L1 (00=reserved)
  if (versionBits === 1 || layerBits === 0) return null;
  const layer = (4 - layerBits) as 1 | 2 | 3; // 11->1, 10->2, 01->3
  const mpegVersion: 1 | 2 = versionBits === 3 ? 1 : 2;
  const bitrateIndex = (buf[off + 2] >> 4) & 0x0f;
  const sampleRateIndex = (buf[off + 2] >> 2) & 0x03;
  const padding = (buf[off + 2] >> 1) & 0x01;
  if (sampleRateIndex === 3) return null;
  // MPEG2/2.5 share one table for layers 2 and 3 ('2-2'), and another for layer 1.
  const brTable =
    mpegVersion === 1 ? BITRATES[`1-${layer}`] : BITRATES[layer === 1 ? '2-1' : '2-2'];
  const bitrateKbps = brTable?.[bitrateIndex] ?? null;
  if (!bitrateKbps) return null;
  const sampleRate = SAMPLE_RATES[versionBits][sampleRateIndex];
  const spf = samplesPerFrame(mpegVersion, layer);
  // Frame length in bytes. Layer 1 uses a 4-byte slot; layers 2/3 a 1-byte slot.
  const frameLength =
    layer === 1
      ? (Math.floor((12 * bitrateKbps * 1000) / sampleRate) + padding) * 4
      : Math.floor(((spf / 8) * bitrateKbps * 1000) / sampleRate) + padding;
  if (frameLength <= 4) return null;
  return { mpegVersion, layer, bitrateKbps, sampleRate, samplesPerFrame: spf, frameLength };
}

/** Skip an ID3v2 tag at the start of `buf`, returning the byte offset of the
 *  first audio frame region. Returns 0 when there is no ID3v2 tag. */
export function skipId3v2(buf: Buffer): number {
  if (buf.length < 10 || buf.toString('latin1', 0, 3) !== 'ID3') return 0;
  // The size is a 28-bit synchsafe integer (7 bits per byte) at bytes 6..9.
  const size =
    ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
  return 10 + size;
}

export interface XingHeader {
  tag: 'Xing' | 'Info';
  /** The frame count the header declares (the "frames" field), or null when the
   *  header omits that field. */
  declaredFrames: number | null;
  /** That frame count expressed in seconds, using the first frame's timing. Null
   *  when the frame count is absent or the first frame could not be parsed. */
  declaredSeconds: number | null;
}

/**
 * Read the Xing (VBR) / Info (CBR) header from the first audio frame, or null
 * when the file has none (a headerless CBR file plays in full, so its absence is
 * not a defect). `declaredSeconds` is what a header-trusting player (Telegram,
 * most phones) will believe the clip lasts.
 */
export function readXingHeader(buf: Buffer): XingHeader | null {
  const start = skipId3v2(buf);
  const frame = parseMp3FrameHeader(buf, start);
  // The Xing/Info tag sits after the frame header + side info; its exact offset
  // depends on version/channel mode, so just search the first frame's bytes.
  const window = buf.subarray(start, start + Math.max(frame?.frameLength ?? 0, 1800));
  let idx = window.indexOf('Xing');
  let tag: 'Xing' | 'Info' = 'Xing';
  if (idx < 0) {
    idx = window.indexOf('Info');
    tag = 'Info';
  }
  if (idx < 0) return null;
  const flags = window.readUInt32BE(idx + 4);
  const hasFrames = (flags & 0x0001) !== 0;
  const declaredFrames = hasFrames ? window.readUInt32BE(idx + 8) : null;
  const declaredSeconds =
    declaredFrames != null && frame
      ? (declaredFrames * frame.samplesPerFrame) / frame.sampleRate
      : null;
  return { tag, declaredFrames, declaredSeconds };
}

/**
 * Count the real audio frames in `buf` and sum their playing time by walking the
 * frame chain (handles CBR and VBR). This is the file's TRUE duration, the number
 * ffprobe agrees with — the one to compare a Xing header's claim against. The
 * Xing/Info header frame is itself a valid (silent) frame and is counted here;
 * the off-by-one against a header's declared count is immaterial next to the
 * gross "first ayah only" defect we are catching.
 */
export function measureMp3(buf: Buffer): { frames: number; seconds: number } {
  let off = skipId3v2(buf);
  let frames = 0;
  let seconds = 0;
  while (off + 4 <= buf.length) {
    const frame = parseMp3FrameHeader(buf, off);
    if (!frame) {
      // Resync: scan forward to the next 0xFF (tolerates junk between frames).
      const next = buf.indexOf(0xff, off + 1);
      if (next < 0) break;
      off = next;
      continue;
    }
    frames++;
    seconds += frame.samplesPerFrame / frame.sampleRate;
    off += frame.frameLength;
  }
  return { frames, seconds };
}
