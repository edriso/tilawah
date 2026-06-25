// The page-audio "trusted resource" check, the audio twin of the ayah bot's
// verify:audio. It answers three questions:
//
//   1. Is the per-ayah SOURCE we build from (everyayah) reachable for each
//      reciter? (Sampled HEAD requests, so you know you can (re)generate.)
//   2. Is a generated self-hosted set COMPLETE? (--dir): every reciter has all
//      604 page files, none empty.
//   3. (--scan-defects) Are everyayah's pre-split PageMp3s usable? Two ways they
//      are not, both checked:
//        a. AYAH-DROP (byte size): a PageMp3's bytes differ from the sum of OUR
//           page's per-ayah clips (the diagnosis that found Abdul Basit's Page011
//           dropping 2:76).
//        b. BAD HEADER (Xing/Info): the clip's frame-count header declares far
//           less than the audio it actually holds, so Telegram and phone players
//           STOP after the first ayah even though every byte is present. This is
//           invisible to a byte-size check (the bytes ARE there) and to ffprobe
//           (it scans frames). everyayah's Alafasy set is fully affected — the
//           "page 383 plays only 27:64" bug. (Diagnostic only; we self-host.)
//      The same BAD HEADER check runs over a built set (--dir, with --deep), so a
//      self-hosted clip whose header did not regenerate correctly is caught
//      before it ships.
//
// Run with:  pnpm verify:audio [flags]
//   --dir <path>      verify a generated set on disk (built by data:page-audio)
//   --deep            with --dir, also check each sampled page's byte size against
//                     the per-ayah sum (catches a concat that dropped an ayah)
//   --reciter <keys>  comma list (default: all)
//   --scan-defects    run the everyayah PageMp3 size-vs-per-ayah diagnostic
//   --full            scan/deep-check all 604 pages (default: a sample)
//
// Read-only: no database, no sending. Network HEAD/GET requests only.

import { existsSync, statSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  RECITERS,
  RECITER_KEYS,
  perAyahAudioUrl,
  pageAudioSource,
  PAGE_AUDIO_TEMPLATE,
  type ReciterKey,
} from '../src/core';
import {
  buildPageAyat,
  pad3,
  pageFileName,
  readXingHeader,
  measureMp3,
  parseMp3FrameHeader,
  skipId3v2,
  type QuranData,
} from './lib/page-audio-build';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const MIN_BYTES = 1024;

const argv = process.argv.slice(2);
const getArg = (flag: string): string | undefined => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};
const dir = getArg('--dir');
const reciterArg = getArg('--reciter');
const reciters = (
  reciterArg ? (reciterArg.split(',').map((s) => s.trim()) as ReciterKey[]) : [...RECITER_KEYS]
).filter((r) => RECITER_KEYS.includes(r));
const scanDefects = argv.includes('--scan-defects');
const deep = argv.includes('--deep');
const full = argv.includes('--full');

const quran = JSON.parse(
  readFileSync(join(ROOT, 'prisma/data/quran-uthmani.json'), 'utf8'),
) as QuranData;
const pageAyat = buildPageAyat(quran);

async function headLen(url: string): Promise<number> {
  try {
    const res = await fetch(url, { method: 'HEAD' });
    return res.ok ? Number(res.headers.get('content-length') ?? 0) : -1;
  } catch {
    return -1;
  }
}

/** Fetch the first `bytes` of a URL (a Range request) — enough to read the ID3
 *  tag, first frame header, and Xing/Info header without downloading the whole
 *  clip. Returns null on any failure. (A server that ignores Range and sends the
 *  full body is fine: we only read the head.) */
async function getHead(url: string, bytes = 8192): Promise<Buffer | null> {
  try {
    const res = await fetch(url, { headers: { Range: `bytes=0-${bytes - 1}` } });
    if (!res.ok && res.status !== 206) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
}

// A header is "truncated" when it claims less than this fraction of the real
// audio. The everyayah Alafasy defects sit at 0.04..0.5; a healthy clip is ~1.0.
const HEADER_MIN_RATIO = 0.7;

/** The clip's real duration in seconds for a CBR file, from its total size and
 *  the first frame's bitrate (everyayah clips are CBR). Used when we only have
 *  the head bytes + Content-Length, not the whole file. Null if unparseable. */
function cbrSeconds(sizeBytes: number, head: Buffer): number | null {
  const id3 = skipId3v2(head);
  const frame = parseMp3FrameHeader(head, id3);
  if (!frame) return null;
  return ((sizeBytes - id3) * 8) / (frame.bitrateKbps * 1000);
}

/** When `head` carries a Xing/Info header that under-declares against
 *  `actualSeconds`, return a human description of the gap; else null. */
function headerUnderDeclares(head: Buffer, actualSeconds: number | null): string | null {
  const header = readXingHeader(head);
  if (!header || header.declaredSeconds == null || !actualSeconds) return null;
  if (header.declaredSeconds >= HEADER_MIN_RATIO * actualSeconds) return null;
  return (
    `${header.tag} header says ${header.declaredSeconds.toFixed(1)}s but the clip is ` +
    `~${actualSeconds.toFixed(1)}s — header-trusting players stop early`
  );
}

const problems: string[] = [];

/** 1. The per-ayah source is reachable (sample a few ayat per reciter). */
async function checkSourceReachable(): Promise<void> {
  console.log('Checking the per-ayah source (everyayah) is reachable...');
  const sample = [
    { surah: 1, ayah: 1 },
    { surah: 2, ayah: 76 }, // the ayah everyayah's Abdul-Basit page set drops
    { surah: 36, ayah: 1 },
    { surah: 114, ayah: 6 },
  ];
  for (const reciter of reciters) {
    const folder = RECITERS[reciter].folder;
    let ok = 0;
    for (const { surah, ayah } of sample) {
      const len = await headLen(perAyahAudioUrl(folder, surah, ayah));
      if (len > MIN_BYTES) ok++;
      else problems.push(`source: ${reciter} ${surah}:${ayah} unreachable (${len})`);
    }
    console.log(`  ${reciter}: ${ok}/${sample.length} sample ayat reachable`);
  }
}

/** 2. A generated set on disk is complete (all 604 pages, none empty), and with
 *  --deep, each sampled page's byte size matches the sum of its ayat's per-ayah
 *  clips (so a concat that dropped or duplicated an ayah is caught, not just a
 *  missing file) AND its Xing/Info header matches the real frame count (so a
 *  build whose header did not regenerate — the everyayah-style "plays only the
 *  first ayah" defect — is caught before it ships). --deep needs the network;
 *  --full deep-checks all 604 pages. */
async function checkLocalSet(root: string): Promise<void> {
  console.log(`\nVerifying generated set in ${root} ...`);
  const deepPages = full
    ? Array.from({ length: 604 }, (_, i) => i + 1)
    : [1, 11, 100, 200, 300, 400, 500, 604];
  for (const reciter of reciters) {
    const folder = RECITERS[reciter].folder;
    let present = 0;
    const missing: number[] = [];
    for (let page = 1; page <= 604; page++) {
      const f = join(root, folder, pageFileName(page));
      if (existsSync(f) && statSync(f).size > MIN_BYTES) present++;
      else missing.push(page);
    }
    console.log(`  ${reciter}: ${present}/604 pages present`);
    if (missing.length) {
      problems.push(
        `local: ${reciter} missing/empty ${missing.length} pages: ` +
          missing.slice(0, 15).map(pad3).join(', ') +
          (missing.length > 15 ? ' ...' : ''),
      );
    }
    if (!deep) continue;
    let checked = 0;
    for (const page of deepPages) {
      const f = join(root, folder, pageFileName(page));
      if (!existsSync(f)) continue;
      const ayat = pageAyat.get(page)!;
      let sum = 0;
      let ok = true;
      for (const { surah, ayah } of ayat) {
        const l = await headLen(perAyahAudioUrl(folder, surah, ayah));
        if (l < 0) {
          ok = false;
          break;
        }
        sum += l;
      }
      if (!ok) continue;
      // The built file is the concatenated ayat plus a little container/tag/cover
      // overhead, so it should be within ~10% of the per-ayah sum. A page that
      // dropped an ayah (like everyayah's) would be far smaller.
      const buf = readFileSync(f);
      const ratio = buf.length / sum;
      checked++;
      if (ratio < 0.9 || ratio > 1.15) {
        problems.push(
          `local: ${reciter} Page${pad3(page)} size off (ratio ${ratio.toFixed(2)}; ` +
            `expected ~${ayat.length} ayat ${ayat[0].surah}:${ayat[0].ayah}..${ayat.at(-1)!.surah}:${ayat.at(-1)!.ayah})`,
        );
      }
      // The built clip must declare its true length, or header-trusting players
      // (Telegram) stop early. Measure the real duration off the file's frames.
      const headerGap = headerUnderDeclares(buf, measureMp3(buf).seconds);
      if (headerGap) problems.push(`local: ${reciter} Page${pad3(page)} ${headerGap}`);
    }
    if (deep) console.log(`    deep-checked ${checked} page(s) against the per-ayah sum`);
  }
}

/** 3. Diagnostic: everyayah PageMp3 (a) byte size vs OUR page's per-ayah sum
 *  (ayah-drop) and (b) Xing/Info header vs the file's real length (the
 *  truncated-header defect that makes a clip stop after the first ayah). */
async function scanEveryayahDefects(): Promise<void> {
  console.log('\nScanning everyayah PageMp3s against our page map (diagnostic)...');
  const pages = full
    ? Array.from({ length: 604 }, (_, i) => i + 1)
    : [3, 11, 12, 50, 100, 200, 300, 400, 500, 604];
  for (const reciter of reciters) {
    const folder = RECITERS[reciter].folder;
    let badSize = 0;
    let badHeader = 0;
    for (const page of pages) {
      const ayat = pageAyat.get(page)!;
      let sum = 0;
      let ok = true;
      for (const { surah, ayah } of ayat) {
        const l = await headLen(perAyahAudioUrl(folder, surah, ayah));
        if (l < 0) {
          ok = false;
          break;
        }
        sum += l;
      }
      const url = pageAudioSource(reciter, page, PAGE_AUDIO_TEMPLATE);
      const pg = await headLen(url);
      if (!ok || pg < 0) continue;
      const ratio = pg / sum;
      if (ratio < 0.97 || ratio > 1.03) {
        badSize++;
        problems.push(
          `everyayah: ${reciter} Page${pad3(page)} size off (ratio ${ratio.toFixed(2)}; ` +
            `our page = ${ayat[0].surah}:${ayat[0].ayah}..${ayat.at(-1)!.surah}:${ayat.at(-1)!.ayah})`,
        );
      }
      // Header check: read just the head bytes and estimate the real (CBR)
      // duration from the full size, then compare to the header's claim.
      const head = await getHead(url);
      const headerGap = head && headerUnderDeclares(head, cbrSeconds(pg, head));
      if (headerGap) {
        badHeader++;
        problems.push(`everyayah: ${reciter} Page${pad3(page)} ${headerGap}`);
      }
    }
    console.log(
      `  ${reciter}: ${badSize} size-defect + ${badHeader} header-defect page(s) of ${pages.length} scanned`,
    );
  }
}

async function main(): Promise<void> {
  await checkSourceReachable();
  if (dir) await checkLocalSet(dir);
  if (scanDefects) await scanEveryayahDefects();

  if (problems.length) {
    console.error(`\n${problems.length} problem(s):`);
    for (const p of problems) console.error('  ' + p);
    process.exit(1);
  }
  console.log('\nAll checks passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
