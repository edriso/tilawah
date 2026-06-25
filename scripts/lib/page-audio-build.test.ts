import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  buildPageAyat,
  pad3,
  pageFileName,
  parseMp3FrameHeader,
  skipId3v2,
  readXingHeader,
  measureMp3,
  type QuranData,
} from './page-audio-build';

const quran = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../prisma/data/quran-uthmani.json', import.meta.url)),
    'utf8',
  ),
) as QuranData;

describe('pad3 / pageFileName', () => {
  it('pads to three digits and names the page file', () => {
    expect(pad3(1)).toBe('001');
    expect(pad3(11)).toBe('011');
    expect(pad3(604)).toBe('604');
    expect(pageFileName(11)).toBe('Page011.mp3');
  });
});

describe('buildPageAyat (from the seeded Quran data = the layout the wird uses)', () => {
  const map = buildPageAyat(quran);

  it('covers all 604 pages and all 6236 ayat', () => {
    expect(map.size).toBe(604);
    const total = [...map.values()].reduce((n, ayat) => n + ayat.length, 0);
    expect(total).toBe(6236);
  });

  it('puts the right ayat on page 11 (2:70..2:76) — the page everyayah got wrong', () => {
    const p11 = map.get(11)!;
    expect(p11[0]).toEqual({ surah: 2, ayah: 70 });
    expect(p11[p11.length - 1]).toEqual({ surah: 2, ayah: 76 });
    expect(p11).toHaveLength(7);
  });

  it('page 1 is Al-Fatihah 1..7 and page 604 opens with Al-Ikhlas', () => {
    const p1 = map.get(1)!;
    expect(p1[0]).toEqual({ surah: 1, ayah: 1 });
    expect(p1[p1.length - 1]).toEqual({ surah: 1, ayah: 7 });
    expect(map.get(604)![0]).toEqual({ surah: 112, ayah: 1 });
  });
});

// ─── MP3 header inspection (the everyayah "plays only the first ayah" defect) ──
//
// Synthetic MPEG1 Layer 3, 128 kbps, 44.1 kHz frames (the everyayah format), so
// the tests run offline. Header = FF FB 90 00; frame length = floor(144 * 128000
// / 44100) = 417 bytes; one frame is 1152 / 44100 = 0.02612 s.
const FRAME_LEN = 417;
const SEC_PER_FRAME = 1152 / 44100;

/** One valid (silent) frame, optionally carrying an Info (CBR Xing) header that
 *  declares `infoFrames` frames — how the real files mark their length. */
function frame(infoFrames?: number): Buffer {
  const f = Buffer.alloc(FRAME_LEN);
  f[0] = 0xff; // sync
  f[1] = 0xfb; // MPEG1, Layer 3, no CRC
  f[2] = 0x90; // bitrate index 9 (128k), sample-rate index 0 (44100), no padding
  f[3] = 0x00; // stereo
  if (infoFrames !== undefined) {
    f.write('Info', 36, 'latin1'); // after the 32-byte MPEG1-stereo side info
    f.writeUInt32BE(0x0001, 40); // flags: frame count present
    f.writeUInt32BE(infoFrames, 44);
  }
  return f;
}

/** A clip of `total` frames whose Info header declares `declared` frames. */
function clip(total: number, declared: number, id3 = 0): Buffer {
  const frames = [frame(declared), ...Array.from({ length: total - 1 }, () => frame())];
  const audio = Buffer.concat(frames);
  if (id3 === 0) return audio;
  const tag = Buffer.alloc(10 + id3);
  tag.write('ID3', 0, 'latin1');
  // 28-bit synchsafe size (id3 < 128 here, so it lands in the last byte).
  tag[9] = id3 & 0x7f;
  return Buffer.concat([tag, audio]);
}

describe('parseMp3FrameHeader', () => {
  it('reads an MPEG1 Layer 3 128 kbps 44.1 kHz frame', () => {
    const fr = parseMp3FrameHeader(frame(), 0)!;
    expect(fr).toMatchObject({
      mpegVersion: 1,
      layer: 3,
      bitrateKbps: 128,
      sampleRate: 44100,
      samplesPerFrame: 1152,
      frameLength: FRAME_LEN,
    });
  });

  it('returns null when there is no frame sync', () => {
    expect(parseMp3FrameHeader(Buffer.from([0x00, 0x00, 0x00, 0x00]), 0)).toBeNull();
  });

  it('returns null on a reserved MPEG version or layer', () => {
    expect(parseMp3FrameHeader(Buffer.from([0xff, 0xe8, 0x90, 0x00]), 0)).toBeNull(); // version 01
    expect(parseMp3FrameHeader(Buffer.from([0xff, 0xf9, 0x90, 0x00]), 0)).toBeNull(); // layer 00
  });
});

describe('skipId3v2', () => {
  it('skips an ID3v2 tag and returns the audio offset', () => {
    expect(skipId3v2(clip(2, 2, 24))).toBe(10 + 24);
  });

  it('returns 0 when there is no ID3v2 tag', () => {
    expect(skipId3v2(frame())).toBe(0);
  });
});

describe('readXingHeader + measureMp3 (the truncated-header defect)', () => {
  it('measures the real frame count and duration by walking the frames', () => {
    const m = measureMp3(clip(10, 10));
    expect(m.frames).toBe(10);
    expect(m.seconds).toBeCloseTo(10 * SEC_PER_FRAME, 4);
  });

  it('measures correctly past an ID3v2 tag', () => {
    expect(measureMp3(clip(7, 7, 30)).frames).toBe(7);
  });

  it('reads the Info header frame count and converts it to seconds', () => {
    const h = readXingHeader(clip(10, 10))!;
    expect(h.tag).toBe('Info');
    expect(h.declaredFrames).toBe(10);
    expect(h.declaredSeconds).toBeCloseTo(10 * SEC_PER_FRAME, 4);
  });

  it('exposes the defect: a header that declares far fewer frames than the file holds', () => {
    // The everyayah Alafasy shape: the file is 10 frames but the Info header
    // claims 1 (the first ayah). A header-trusting player stops after frame 1.
    const buf = clip(10, 1);
    const declared = readXingHeader(buf)!.declaredSeconds!;
    const actual = measureMp3(buf).seconds;
    expect(measureMp3(buf).frames).toBe(10); // every byte is present...
    expect(declared / actual).toBeLessThan(0.7); // ...but the header lies
  });

  it('returns null for a headerless clip (plays in full, not a defect)', () => {
    expect(readXingHeader(clip(5, 5).subarray(FRAME_LEN))).toBeNull(); // drop the Info frame
  });
});
