// Get the Madani Mushaf page images ONCE, integrity-check every page, and write
// them plus a manifest of SHA-256 fingerprints to disk. This lets you SELF-HOST
// a verified copy instead of depending on a third-party host at runtime: review
// the pages once, then serve them yourself (your own static host, or
// upload-from-disk) and the bot never fetches from a stranger again.
//
// Two ways to GET the pages:
//   1. Download from a URL template (the original flow), or
//   2. Import an already-prepared local set with --from-dir (the way the
//      non-Hafs riwayat and the KFGQPC Madinah Hafs set are produced: render a
//      verified KFGQPC PDF to 001.jpg..604.jpg, then import + fingerprint here).
//
// Run with:
//   pnpm data:mushaf [--source <urlTemplate>] [--out <dir>] [--pages <n>]
//   pnpm data:mushaf --from-dir <dir> --out assets/mushaf/<riwayah> [--source <label>]
//
//   --source    With a URL: the template (with {page}/{page3}) to download FROM;
//               defaults to MUSHAF_IMAGE_BASE_URL when it is an http URL, else
//               the colored Tajweed Hafs set on QuranHub. With --from-dir: a free
//               text label recorded in the manifest (e.g. the source PDF name).
//   --from-dir  Import 001..604 from a local folder instead of downloading. The
//               files are validated (real image, sane size) and copied to --out.
//   --out       Where to write the images. Default: assets/mushaf. Each riwayah
//               lives in its own subfolder, e.g. assets/mushaf/hafs.
//   --pages     For a quick test, only pages 1..N. Default: 604.
//
// Re-verify an already-prepared set offline (no network), against its manifest:
//   pnpm data:mushaf --check --out assets/mushaf/<riwayah>
//
// What "verified" means here: the manifest pins the exact bytes you wrote, so a
// later run flags ANY change (tampering, a swapped edition, a truncated copy).
// It does NOT prove the pages are religiously correct — eyeball a few yourself
// the first time (for a PDF import, confirm the Mushaf page number printed on
// the page matches the file number). The bot's authoritative text stays the
// verified Tanzil text in the database; these images are only what the reader sees.

import { createHash } from 'node:crypto';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from '../src/core';
import { PAGE_COUNT } from '../src/database/reference/pages';

loadEnv();

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

// A download fallback only (used when neither --source nor an http
// MUSHAF_IMAGE_BASE_URL is set): the colored Tajweed Hafs Madani set, 604 pages.
// The SHIPPED Hafs set is NOT this — it is the official KFGQPC مصحف المدينة Hafs
// 1440 set rendered from the verified PDF and imported with --from-dir (the same
// way the Qaloon/Warsh sets are produced; see docs/RIWAYAT.md).
const DEFAULT_SOURCE =
  'https://raw.githubusercontent.com/QuranHub/quran-pages-images/main/easyquran.com/hafs-tajweed/{page}.jpg';

// Reject anything that is not a real image of a sane size (catches HTML error
// pages served with a 200, truncated downloads, etc).
const MIN_BYTES = 2 * 1024; // 2 KB
const MAX_BYTES = 5 * 1024 * 1024; // 5 MB (Telegram's photo-by-URL limit)
const CONCURRENCY = 6;
const RETRIES = 2;

interface ManifestEntry {
  sha256: string;
  bytes: number;
}
interface Manifest {
  source: string;
  pageCount: number;
  pages: Record<string, ManifestEntry>; // keyed by zero-padded page, e.g. "050"
}

/** Build a page's source from the template (same rules as the bot). */
function pageSource(template: string, page: number): string {
  return template.replace(/\{page3\}/g, pad(page)).replace(/\{page\}/g, String(page));
}

const pad = (page: number) => String(page).padStart(3, '0');
const sha256 = (buf: Buffer) => createHash('sha256').update(buf).digest('hex');

/** True for a real JPEG or PNG by magic bytes, so an HTML "not found" page that
 *  came back with a 200 is rejected. */
function looksLikeImage(buf: Buffer): boolean {
  const jpeg = buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  const png =
    buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  return jpeg || png;
}

async function downloadPage(template: string, page: number): Promise<Buffer> {
  const url = pageSource(template, page);
  let lastErr = '';
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'tilawah-bot/1.0 (mushaf images)' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (!looksLikeImage(buf)) throw new Error('not a JPEG/PNG (got an error page?)');
      if (buf.length < MIN_BYTES) throw new Error(`too small (${buf.length} bytes)`);
      if (buf.length > MAX_BYTES) throw new Error(`over 5 MB (${buf.length} bytes)`);
      return buf;
    } catch (err) {
      lastErr = String(err);
      if (attempt < RETRIES) await sleep(500 * (attempt + 1));
    }
  }
  throw new Error(`page ${page}: ${lastErr}\n  ${url}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Run tasks with a small concurrency cap, preserving order of results. */
async function pool<T>(
  items: number[],
  limit: number,
  fn: (n: number) => Promise<T>,
): Promise<T[]> {
  const out: T[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

function readManifest(path: string): Manifest | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Manifest;
  } catch {
    return null;
  }
}

// ── --check: verify the on-disk files against the manifest, no network ──
function checkLocal(outDir: string, ext: string): void {
  const manifestPath = join(outDir, 'manifest.json');
  const manifest = readManifest(manifestPath);
  if (!manifest) {
    console.error(`No manifest at ${manifestPath}. Run "pnpm data:mushaf" first.`);
    process.exit(1);
  }
  console.log(`Verifying ${Object.keys(manifest.pages).length} pages in ${outDir} ...`);
  const problems: string[] = [];
  for (let page = 1; page <= manifest.pageCount; page++) {
    const key = pad(page);
    const expected = manifest.pages[key];
    const file = join(outDir, `${key}${ext}`);
    if (!expected) {
      problems.push(`page ${page}: missing from manifest`);
      continue;
    }
    if (!existsSync(file)) {
      problems.push(`page ${page}: file missing (${file})`);
      continue;
    }
    const buf = readFileSync(file);
    if (sha256(buf) !== expected.sha256) problems.push(`page ${page}: SHA-256 mismatch (changed!)`);
  }
  if (problems.length) {
    console.error(`\n✗ ${problems.length} problem(s):`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log(`✓ All ${manifest.pageCount} pages match the manifest.`);
}

/** Find page N's file in a local import folder. We accept 001.jpg / 001.png (and
 *  the un-padded 1.jpg as a courtesy), returning the first that exists. */
function findLocalPage(dir: string, page: number): string | null {
  for (const name of [`${pad(page)}.jpg`, `${pad(page)}.png`, `${page}.jpg`, `${page}.png`]) {
    const file = join(dir, name);
    if (existsSync(file)) return file;
  }
  return null;
}

// ── --from-dir: import an already-prepared local set (e.g. rendered from a
// verified KFGQPC PDF), validate every page, copy it to outDir, write manifest ─
function importLocal(fromDir: string, outDir: string, lastPage: number, label: string): void {
  const src = resolve(ROOT, fromDir);
  if (!existsSync(src)) {
    console.error(`--from-dir not found: ${src}`);
    process.exit(1);
  }
  console.log(`Importing ${lastPage} pages from:\n  ${src}\ninto ${outDir}\n`);
  mkdirSync(outDir, { recursive: true });
  const prev = readManifest(join(outDir, 'manifest.json'));

  const manifest: Manifest = { source: label, pageCount: lastPage, pages: {} };
  const problems: string[] = [];
  const changed: number[] = [];

  for (let page = 1; page <= lastPage; page++) {
    const file = findLocalPage(src, page);
    if (!file) {
      problems.push(`page ${page}: no 001.jpg/png style file in ${src}`);
      continue;
    }
    const buf = readFileSync(file);
    if (!looksLikeImage(buf)) {
      problems.push(`page ${page}: not a JPEG/PNG (${file})`);
      continue;
    }
    if (buf.length < MIN_BYTES) {
      problems.push(`page ${page}: too small (${buf.length} bytes)`);
      continue;
    }
    // The bot uploads a local file (10 MB Telegram limit), so we do not apply the
    // 5 MB photo-by-URL cap here; a verified Mushaf page is well under either.
    const key = pad(page);
    const hash = sha256(buf);
    writeFileSync(join(outDir, `${key}${extname(file) || '.jpg'}`), buf);
    manifest.pages[key] = { sha256: hash, bytes: buf.length };
    if (prev?.pages[key] && prev.pages[key]!.sha256 !== hash) changed.push(page);
    if (page % 100 === 0 || page === lastPage) console.log(`  ${page}/${lastPage}`);
  }

  if (problems.length) {
    console.error(`\n✗ ${problems.length} problem(s):`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }

  writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  const totalMb = (
    Object.values(manifest.pages).reduce((s, e) => s + e.bytes, 0) /
    (1024 * 1024)
  ).toFixed(1);
  console.log(`\n✓ Imported ${lastPage} pages (${totalMb} MB) + manifest.json to ${outDir}`);
  if (prev && changed.length) {
    console.log(
      `⚠ ${changed.length} page(s) changed vs the previous manifest: ${changed.join(', ')}`,
    );
  }
  console.log(`\nRe-verify any time with: pnpm data:mushaf --check --out ${outDir}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const check = args.includes('--check');
  const flag = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };

  const fromDir = flag('--from-dir');
  // resolve() handles both a relative dir (against the repo root) and an
  // absolute one (e.g. the in-container /app/assets/mushaf volume mount).
  const outDir = resolve(ROOT, flag('--out') || 'assets/mushaf');
  const lastPage = flag('--pages') ? Number(flag('--pages')) : PAGE_COUNT;

  // Import mode: the pages already exist locally (no download, no URL template).
  if (fromDir) {
    const label = flag('--source') || `local import: ${fromDir}`;
    importLocal(fromDir, outDir, lastPage, label);
    return;
  }

  const envUrl = process.env.MUSHAF_IMAGE_BASE_URL?.trim();
  const source =
    flag('--source') || (envUrl && /^https?:\/\//i.test(envUrl) ? envUrl : DEFAULT_SOURCE);
  const ext = extname(source) || '.jpg';

  if (!/\{page3?\}/.test(source)) {
    console.error(`Source template needs a {page} or {page3} placeholder. Got: ${source}`);
    process.exit(1);
  }

  if (check) {
    checkLocal(outDir, ext);
    return;
  }

  mkdirSync(outDir, { recursive: true });
  const prev = readManifest(join(outDir, 'manifest.json'));
  const pages = Array.from({ length: lastPage }, (_, i) => i + 1);

  console.log(`Downloading ${pages.length} pages from:\n  ${source}\ninto ${outDir}\n`);

  let done = 0;
  const changed: number[] = [];
  const manifest: Manifest = { source, pageCount: lastPage, pages: {} };

  await pool(pages, CONCURRENCY, async (page) => {
    const buf = await downloadPage(source, page);
    const key = pad(page);
    const hash = sha256(buf);
    writeFileSync(join(outDir, `${key}${ext}`), buf);
    manifest.pages[key] = { sha256: hash, bytes: buf.length };
    if (prev?.pages[key] && prev.pages[key]!.sha256 !== hash) changed.push(page);
    done++;
    if (done % 50 === 0 || done === pages.length) console.log(`  ${done}/${pages.length}`);
  });

  // Final integrity gate: every page present.
  const missing = pages.filter((p) => !manifest.pages[pad(p)]);
  if (missing.length) {
    console.error(`\n✗ Missing pages: ${missing.join(', ')}`);
    process.exit(1);
  }

  writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

  const totalMb = (
    Object.values(manifest.pages).reduce((s, e) => s + e.bytes, 0) /
    (1024 * 1024)
  ).toFixed(1);
  console.log(`\n✓ Saved ${pages.length} pages (${totalMb} MB) + manifest.json to ${outDir}`);
  if (prev && changed.length) {
    console.log(
      `⚠ ${changed.length} page(s) changed vs the previous manifest: ${changed.join(', ')}`,
    );
  }
  console.log(
    `\nServe them and point the bot at them, e.g. on your own host:\n` +
      `  MUSHAF_IMAGE_BASE_URL="https://your-host.example/mushaf/{page3}${ext}"\n` +
      `Re-verify any time with: pnpm data:mushaf --check`,
  );
}

main().catch((err) => {
  console.error('\nFailed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
