// Clear cached Mushaf page-image file_ids (the `mushaf_page_images` table), so
// the NEXT send re-uploads each page from the CURRENT source.
//
// Why this exists: the first time a page goes out as a photo, Telegram stores
// the image and hands back a file_id we cache and reuse forever. If you then
// replace the page images for a riwayah — most importantly, swapping the Hafs
// set for the verified KFGQPC مصحف المدينة PDF render — the cache still points at
// Telegram's copy of the OLD image, so image-format readers keep seeing it. Drop
// the matching rows and the next delivery rebuilds them from the new files. This
// is the image twin of clear:page-audio.
//
// Run with:  pnpm clear:mushaf-images [flags]
//   --riwayah <key>   hafs | warsh-azraq | warsh-asbahani | qaloon. Omit = all.
//   --page <n>        a single Mushaf page (1..604). Omit = every page.
//   --yes             actually delete. WITHOUT it, this only PREVIEWS the count.
//
// Safe by default: with no --yes it is a dry run (counts what WOULD be deleted),
// so you can check the blast radius before committing. Examples:
//   pnpm clear:mushaf-images --riwayah hafs            # preview
//   pnpm clear:mushaf-images --riwayah hafs --yes      # do it

import { prisma } from '../src/database/client';
import {
  clearCachedPageImages,
  countCachedPageImages,
} from '../src/database/services/mushaf-image.service';
import { isRiwayah, type RiwayahKey } from '../src/core';

const argv = process.argv.slice(2);
const getArg = (flag: string): string | undefined => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};

function parseFilter(): { riwayah?: RiwayahKey; page?: number } {
  const filter: { riwayah?: RiwayahKey; page?: number } = {};

  const riwayahArg = getArg('--riwayah');
  if (riwayahArg) {
    if (!isRiwayah(riwayahArg)) {
      throw new Error(
        `Unknown riwayah "${riwayahArg}". Known: hafs, warsh-azraq, warsh-asbahani, qaloon`,
      );
    }
    filter.riwayah = riwayahArg;
  }

  const pageArg = getArg('--page');
  if (pageArg !== undefined) {
    const page = Number(pageArg);
    if (!Number.isInteger(page) || page < 1 || page > 604) {
      throw new Error(`--page must be an integer 1..604, got "${pageArg}"`);
    }
    filter.page = page;
  }

  return filter;
}

function describe(filter: { riwayah?: RiwayahKey; page?: number }): string {
  const parts: string[] = [];
  if (filter.riwayah) parts.push(`riwayah = ${filter.riwayah}`);
  if (filter.page !== undefined) parts.push(`page = ${filter.page}`);
  return parts.length ? parts.join(', ') : 'EVERY cached page image (no filter)';
}

async function main(): Promise<void> {
  const filter = parseFilter();
  const confirmed = argv.includes('--yes');

  const matched = await countCachedPageImages(filter);
  console.log(`Filter: ${describe(filter)}`);
  console.log(`Matching cached rows: ${matched}`);

  if (matched === 0) {
    console.log('Nothing to clear.');
    return;
  }
  if (!confirmed) {
    console.log('\nDry run (no rows deleted). Re-run with --yes to delete them.');
    return;
  }

  const deleted = await clearCachedPageImages(filter);
  console.log(
    `\nDeleted ${deleted} row(s). The next send re-uploads them from the current source.`,
  );
}

main()
  .catch((err) => {
    console.error(String(err instanceof Error ? err.message : err));
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
