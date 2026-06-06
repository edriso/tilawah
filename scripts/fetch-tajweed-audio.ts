// Download the per-ayah recitation clips used as the daily tajweed lesson's
// audio example ONCE, integrity-check them, and write them plus a manifest of
// SHA-256 fingerprints to disk — so you can SELF-HOST a verified copy instead of
// depending on a third-party host at runtime (the same approach as the Mushaf
// images). Only the ayat actually referenced by the lesson deck are fetched
// (~45 small clips).
//
// Run with:  pnpm data:tajweed  [--source <urlTemplate>] [--out <dir>]
//   --source  URL template with {surah3}{ayah3} (or {surah}/{ayah}) to download
//             FROM. Defaults to the Husary murattal set on everyayah.com (the
//             teaching standard).
//   --out     where to write the clips. Default: assets/tajweed
//
// Re-verify an already-downloaded set offline against the manifest:
//   pnpm data:tajweed --check
//
// What "verified" means: the manifest pins the exact bytes you downloaded, so a
// later run flags ANY upstream change. Listen to a few yourself the first time.

import { createHash } from 'node:crypto';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv, tajweedAudioSource } from '../src/core';
import { TAJWEED_LESSONS } from '../src/database/reference/tajweed-lessons';

loadEnv();

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

// Husary (murattal) per-ayah clips on everyayah.com — the universal teaching
// standard. Filenames are SSSAAA.mp3 (zero-padded surah+ayah).
const DEFAULT_SOURCE = 'https://everyayah.com/data/Husary_128kbps/{surah3}{ayah3}.mp3';

const MIN_BYTES = 1024; // 1 KB (reject HTML error pages served with a 200)
const MAX_BYTES = 20 * 1024 * 1024; // 20 MB (Telegram audio-by-URL limit)
const RETRIES = 2;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sha256 = (buf: Buffer) => createHash('sha256').update(buf).digest('hex');
const pad = (n: number) => String(n).padStart(3, '0');

interface Ref {
  surah: number;
  ayah: number;
}

/** The distinct (surah, ayah) example clips the deck needs. */
function exampleRefs(): Ref[] {
  const seen = new Set<string>();
  const refs: Ref[] = [];
  for (const lesson of TAJWEED_LESSONS) {
    const key = `${lesson.example.surah}:${lesson.example.ayah}`;
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push({ surah: lesson.example.surah, ayah: lesson.example.ayah });
  }
  return refs;
}

/** True for a real MP3 by magic bytes (ID3 tag or MPEG frame sync), so an HTML
 *  "not found" page returned with a 200 is rejected. */
function looksLikeMp3(buf: Buffer): boolean {
  if (buf.length < 3) return false;
  const id3 = buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33; // "ID3"
  const frame = buf[0] === 0xff && (buf[1]! & 0xe0) === 0xe0; // MPEG frame sync
  return id3 || frame;
}

async function download(template: string, ref: Ref): Promise<Buffer> {
  const url = tajweedAudioSource(template, ref.surah, ref.ayah);
  let lastErr = '';
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'tilawah-bot/1.0 (tajweed audio)' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (!looksLikeMp3(buf)) throw new Error('not an MP3 (got an error page?)');
      if (buf.length < MIN_BYTES) throw new Error(`too small (${buf.length} bytes)`);
      if (buf.length > MAX_BYTES) throw new Error(`over 20 MB (${buf.length} bytes)`);
      return buf;
    } catch (err) {
      lastErr = String(err);
      if (attempt < RETRIES) await sleep(500 * (attempt + 1));
    }
  }
  throw new Error(`${pad(ref.surah)}${pad(ref.ayah)}: ${lastErr}\n  ${url}`);
}

interface Manifest {
  source: string;
  clips: Record<string, { sha256: string; bytes: number }>; // keyed "SSSAAA"
}

function readManifest(path: string): Manifest | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Manifest;
  } catch {
    return null;
  }
}

function checkLocal(outDir: string): void {
  const manifest = readManifest(join(outDir, 'manifest.json'));
  if (!manifest) {
    console.error(`No manifest at ${outDir}. Run "pnpm data:tajweed" first.`);
    process.exit(1);
  }
  const problems: string[] = [];
  for (const [key, expected] of Object.entries(manifest.clips)) {
    const file = join(outDir, `${key}.mp3`);
    if (!existsSync(file)) {
      problems.push(`${key}: file missing`);
      continue;
    }
    if (sha256(readFileSync(file)) !== expected.sha256) problems.push(`${key}: SHA-256 mismatch`);
  }
  if (problems.length) {
    console.error(`\n✗ ${problems.length} problem(s):`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log(`✓ All ${Object.keys(manifest.clips).length} clips match the manifest.`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const outDir = resolve(ROOT, flag('--out') || 'assets/tajweed');

  if (args.includes('--check')) {
    checkLocal(outDir);
    return;
  }

  const envUrl = process.env.TAJWEED_AUDIO_BASE_URL?.trim();
  const source =
    flag('--source') || (envUrl && /^https?:\/\//i.test(envUrl) ? envUrl : DEFAULT_SOURCE);
  const refs = exampleRefs();

  mkdirSync(outDir, { recursive: true });
  console.log(
    `Downloading ${refs.length} tajweed example clips from:\n  ${source}\ninto ${outDir}\n`,
  );

  const manifest: Manifest = { source, clips: {} };
  let done = 0;
  // Small set; download sequentially to be gentle on the host.
  for (const ref of refs) {
    const buf = await download(source, ref);
    const key = `${pad(ref.surah)}${pad(ref.ayah)}`;
    writeFileSync(join(outDir, `${key}.mp3`), buf);
    manifest.clips[key] = { sha256: sha256(buf), bytes: buf.length };
    console.log(`  ${++done}/${refs.length}  ${key}`);
  }

  writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  const totalMb = (
    Object.values(manifest.clips).reduce((s, e) => s + e.bytes, 0) /
    (1024 * 1024)
  ).toFixed(1);
  console.log(`\n✓ Saved ${refs.length} clips (${totalMb} MB) + manifest.json to ${outDir}`);
  console.log(
    `\nServe them and point the bot at them, e.g.:\n` +
      `  TAJWEED_AUDIO_BASE_URL="https://your-host.example/tajweed/{surah3}{ayah3}.mp3"\n` +
      `or a local path the bot uploads:\n` +
      `  TAJWEED_AUDIO_BASE_URL="${join(outDir, '{surah3}{ayah3}.mp3')}"\n` +
      `Re-verify any time with: pnpm data:tajweed --check`,
  );
}

main().catch((err) => {
  console.error('\nFailed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
