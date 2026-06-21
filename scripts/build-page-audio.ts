// Build a VERIFIED, self-hosted per-page recitation set, one MP3 per Mushaf page
// per reciter, so the bot never depends on everyayah's pre-split PageMp3s (which
// are NOT ayah-accurate: e.g. Abdul Basit's Page011 drops 2:76, and all carry
// junk ID3 tags with no cover art).
//
// How it stays correct: for each page it downloads the TRUSTED per-ayah clips
// (everyayah, the same source the tajweed audio and the ayah bot use) for EXACTLY
// the ayat our Madani layout puts on that page (buildPageAyat, the same data the
// wird text uses), size-checks each one, concatenates them with ffmpeg, and
// stamps clean ID3 tags plus a constant cover image. The result matches the page
// the reader sees, every time, for every reciter.
//
// Run with:  pnpm data:page-audio [flags]
//   --reciter <keys>  comma list of reciter keys (default: all). e.g. abdulbasit,husary
//   --cover <path>    a square JPG/PNG embedded as the clip cover (strongly
//                     recommended; fixes the random-thumbnail problem). Omit to
//                     build without a cover (range still fixed, no art).
//   --out <dir>       output root. Default: assets/page-audio
//   --from <n> --to <n>  page range (default 1..604), handy for a test slice.
//   --force           rebuild pages that already exist (default: skip them).
//
// Output layout (matches the runtime PAGE_AUDIO_BASE_URL template
// "/app/assets/page-audio/{folder}/Page{page3}.mp3"):
//   <out>/<reciter-folder>/Page001.mp3 ... Page604.mp3
//
// Then rsync <out>/ to /opt/bots/data/tilawah/page-audio/ on the server, mount it
// read-only into the container, and set PAGE_AUDIO_BASE_URL. See DEVELOPMENT.md
// and docs. Verify the result with: pnpm verify:audio --dir <out>
//
// Requires ffmpeg on PATH. It is resumable: a finished page is skipped unless
// --force, so a long run can be stopped and restarted.

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, statSync, rmSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { RECITERS, RECITER_KEYS, perAyahAudioUrl, type ReciterKey } from '../src/core';
import { reciterNameAr } from '../src/lib/copy';
import { buildPageAyat, pad3, pageFileName, type QuranData } from './lib/page-audio-build';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

const MIN_AYAH_BYTES = 1024; // reject an HTML error page served with a 200
const RETRIES = 3;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Args {
  reciters: ReciterKey[];
  cover: string | null;
  out: string;
  from: number;
  to: number;
  force: boolean;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const reciterArg = get('--reciter');
  let reciters: ReciterKey[] = [...RECITER_KEYS];
  if (reciterArg) {
    reciters = reciterArg.split(',').map((s) => s.trim()) as ReciterKey[];
    for (const r of reciters) {
      if (!RECITER_KEYS.includes(r)) {
        throw new Error(`Unknown reciter "${r}". Known: ${RECITER_KEYS.join(', ')}`);
      }
    }
  }
  return {
    reciters,
    cover: get('--cover') ? resolve(get('--cover')!) : null,
    out: resolve(get('--out') ?? join(ROOT, 'assets/page-audio')),
    from: Number(get('--from') ?? 1),
    to: Number(get('--to') ?? 604),
    force: argv.includes('--force'),
  };
}

/** Run ffmpeg and return true on success (exit 0), logging stderr on failure. */
function ffmpeg(args: string[]): boolean {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
    encoding: 'utf8',
  });
  if (r.status !== 0) {
    console.error(`  ffmpeg failed: ${r.stderr?.trim() || r.error?.message || 'unknown error'}`);
    return false;
  }
  return true;
}

function ensureFfmpeg(): void {
  const r = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error('ffmpeg not found on PATH. Install it (e.g. "apt install ffmpeg") and retry.');
  }
}

/** Download one per-ayah clip to `dest`, with retries and a size sanity check. */
async function downloadAyah(url: string, dest: string): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < MIN_AYAH_BYTES) throw new Error(`too small (${buf.length} bytes)`);
      writeFileSync(dest, buf);
      return;
    } catch (err) {
      lastErr = err;
      if (attempt < RETRIES) await sleep(attempt * 1000);
    }
  }
  throw new Error(`failed to download ${url}: ${String(lastErr)}`);
}

/**
 * Build one page clip: download its ayat, concat, then stamp tags + cover.
 * Returns true on success. Leaves no temp files behind.
 */
async function buildPage(
  reciter: ReciterKey,
  folder: string,
  page: number,
  ayat: { surah: number; ayah: number }[],
  outFile: string,
  cover: string | null,
): Promise<boolean> {
  const work = join(tmpdir(), `tilawah-pageaudio-${folder}-${pad3(page)}`);
  mkdirSync(work, { recursive: true });
  try {
    // 1) Download the page's ayat (in order) from the trusted per-ayah source.
    const parts: string[] = [];
    for (const { surah, ayah } of ayat) {
      const dest = join(work, `${pad3(surah)}${pad3(ayah)}.mp3`);
      await downloadAyah(perAyahAudioUrl(folder, surah, ayah), dest);
      parts.push(dest);
    }
    // 2) Concatenate (stream copy, no re-encode: one reciter's clips share codec
    //    params). The concat demuxer reads a list file of absolute paths.
    const listFile = join(work, 'list.txt');
    writeFileSync(listFile, parts.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'));
    const joined = join(work, 'joined.mp3');
    const concatOk =
      ffmpeg(['-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', joined]) ||
      // Fallback: re-encode if a reciter's clips have mismatched params.
      ffmpeg([
        '-f',
        'concat',
        '-safe',
        '0',
        '-i',
        listFile,
        '-c:a',
        'libmp3lame',
        '-q:a',
        '2',
        joined,
      ]);
    if (!concatOk) return false;

    // 3) Stamp clean ID3 tags (and the cover, when given). Stream copy so the
    //    audio is untouched; only the tags/cover are written.
    const title = `صفحة ${page}`;
    const meta = [
      '-metadata',
      `title=${title}`,
      '-metadata',
      `artist=${reciterNameAr(reciter)}`,
      '-metadata',
      'album=القرآن الكريم',
      '-metadata',
      'comment=',
      '-id3v2_version',
      '3',
    ];
    // `-map_metadata -1` drops any ID3 the per-ayah source files carried into the
    // concatenated file, so only our clean tags (and the cover) remain.
    const ok = cover
      ? ffmpeg([
          '-i',
          joined,
          '-i',
          cover,
          '-map',
          '0:a',
          '-map',
          '1:v',
          '-c',
          'copy',
          '-map_metadata',
          '-1',
          '-disposition:v:0',
          'attached_pic',
          '-metadata:s:v',
          'title=Album cover',
          '-metadata:s:v',
          'comment=Cover (front)',
          ...meta,
          outFile,
        ])
      : ffmpeg(['-i', joined, '-c', 'copy', '-map_metadata', '-1', ...meta, outFile]);
    return ok;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  ensureFfmpeg();
  if (args.cover && !existsSync(args.cover)) {
    throw new Error(`--cover file not found: ${args.cover}`);
  }
  if (!args.cover) {
    console.warn('No --cover given: clips will have clean tags but no cover art.');
  }

  const quran = JSON.parse(
    readFileSync(join(ROOT, 'prisma/data/quran-uthmani.json'), 'utf8'),
  ) as QuranData;
  const pageAyat = buildPageAyat(quran);

  let built = 0;
  let skipped = 0;
  const failures: string[] = [];

  for (const reciter of args.reciters) {
    const folder = RECITERS[reciter].folder;
    const outDir = join(args.out, folder);
    mkdirSync(outDir, { recursive: true });
    console.log(`\n=== ${reciter} (${folder}) ===`);
    for (let page = args.from; page <= args.to; page++) {
      const ayat = pageAyat.get(page);
      if (!ayat) {
        failures.push(`${reciter} page ${page}: no ayat in the page map`);
        continue;
      }
      const outFile = join(outDir, pageFileName(page));
      if (!args.force && existsSync(outFile) && statSync(outFile).size > MIN_AYAH_BYTES) {
        skipped++;
        continue;
      }
      process.stdout.write(`  page ${pad3(page)} (${ayat.length} ayat) ... `);
      try {
        const ok = await buildPage(reciter, folder, page, ayat, outFile, args.cover);
        if (ok) {
          built++;
          console.log('ok');
        } else {
          failures.push(`${reciter} page ${page}: ffmpeg failed`);
          console.log('FAILED');
        }
      } catch (err) {
        failures.push(`${reciter} page ${page}: ${String(err)}`);
        console.log('FAILED');
      }
    }
  }

  console.log(`\nDone. built=${built} skipped=${skipped} failed=${failures.length}`);
  if (failures.length) {
    console.error('\nFailures:');
    for (const f of failures) console.error('  ' + f);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
