// The page-audio "trusted resource" check, the audio twin of the ayah bot's
// verify:audio. It answers three questions:
//
//   1. Is the per-ayah SOURCE we build from (everyayah) reachable for each
//      reciter? (Sampled HEAD requests, so you know you can (re)generate.)
//   2. Is a generated self-hosted set COMPLETE? (--dir): every reciter has all
//      604 page files, none empty.
//   3. (--scan-defects) Are everyayah's pre-split PageMp3s ayah-accurate? This
//      reproduces the diagnosis that found Abdul Basit's Page011 dropping 2:76:
//      it compares each PageMp3's byte size to the sum of OUR page's per-ayah
//      clips and flags the mismatches. (Diagnostic only; we self-host instead.)
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
import { buildPageAyat, pad3, pageFileName, type QuranData } from './lib/page-audio-build';

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
 *  missing file). --deep needs the network; --full deep-checks all 604 pages. */
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
      const ratio = statSync(f).size / sum;
      checked++;
      if (ratio < 0.9 || ratio > 1.15) {
        problems.push(
          `local: ${reciter} Page${pad3(page)} size off (ratio ${ratio.toFixed(2)}; ` +
            `expected ~${ayat.length} ayat ${ayat[0].surah}:${ayat[0].ayah}..${ayat.at(-1)!.surah}:${ayat.at(-1)!.ayah})`,
        );
      }
    }
    if (deep) console.log(`    deep-checked ${checked} page(s) against the per-ayah sum`);
  }
}

/** 3. Diagnostic: everyayah PageMp3 size vs OUR page's per-ayah sum. */
async function scanEveryayahDefects(): Promise<void> {
  console.log('\nScanning everyayah PageMp3s against our page map (diagnostic)...');
  const pages = full
    ? Array.from({ length: 604 }, (_, i) => i + 1)
    : [3, 11, 12, 50, 100, 200, 300, 400, 500, 604];
  for (const reciter of reciters) {
    const folder = RECITERS[reciter].folder;
    let bad = 0;
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
      const pg = await headLen(pageAudioSource(reciter, page, PAGE_AUDIO_TEMPLATE));
      if (!ok || pg < 0) continue;
      const ratio = pg / sum;
      if (ratio < 0.97 || ratio > 1.03) {
        bad++;
        problems.push(
          `everyayah: ${reciter} Page${pad3(page)} size off (ratio ${ratio.toFixed(2)}; ` +
            `our page = ${ayat[0].surah}:${ayat[0].ayah}..${ayat.at(-1)!.surah}:${ayat.at(-1)!.ayah})`,
        );
      }
    }
    console.log(`  ${reciter}: ${bad} defective page(s) of ${pages.length} scanned`);
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
