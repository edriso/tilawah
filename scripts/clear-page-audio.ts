// Clear cached page-recitation file_ids (the `page_audio` table), so the NEXT
// send re-uploads each clip from the CURRENT source.
//
// Why this exists: the first time a page goes out in a reciter's voice, Telegram
// stores the file and hands back a file_id we cache and reuse forever. If you
// then change where that clip comes from — most importantly, hosting a verified
// self-hosted set in place of the everyayah fallback (whose Alafasy clips have a
// truncated header that makes them stop after the first ayah) — the cache still
// points at Telegram's copy of the OLD clip, so readers keep hearing it. Drop
// the matching rows and the next delivery rebuilds them from the new files.
//
// Run with:  pnpm clear:page-audio [flags]
//   --reciter <keys>   comma list (e.g. alafasy,husary). Omit = every reciter.
//   --riwayah <key>    hafs | warsh-azraq | warsh-asbahani | qaloon. Omit = all.
//   --page <n>         a single Mushaf page (1..604). Omit = every page.
//   --yes              actually delete. WITHOUT it, this only PREVIEWS the count.
//
// Safe by default: with no --yes it is a dry run (counts what WOULD be deleted),
// so you can check the blast radius before committing. Examples:
//   pnpm clear:page-audio --reciter alafasy            # preview
//   pnpm clear:page-audio --reciter alafasy --yes      # do it
//   pnpm clear:page-audio --reciter alafasy,husary,sudais,minshawi --yes

import { prisma } from '../src/database/client';
import {
  clearCachedPageAudio,
  countCachedPageAudio,
} from '../src/database/services/page-audio.service';
import { isReciter, isRiwayah, RECITER_KEYS, type RiwayahKey } from '../src/core';

const argv = process.argv.slice(2);
const getArg = (flag: string): string | undefined => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};

function parseFilter(): { reciters?: string[]; riwayah?: RiwayahKey; page?: number } {
  const filter: { reciters?: string[]; riwayah?: RiwayahKey; page?: number } = {};

  const reciterArg = getArg('--reciter');
  if (reciterArg) {
    const reciters = reciterArg.split(',').map((s) => s.trim());
    for (const r of reciters) {
      if (!isReciter(r))
        throw new Error(`Unknown reciter "${r}". Known: ${RECITER_KEYS.join(', ')}`);
    }
    filter.reciters = reciters;
  }

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

function describe(filter: { reciters?: string[]; riwayah?: RiwayahKey; page?: number }): string {
  const parts: string[] = [];
  if (filter.reciters) parts.push(`reciter in [${filter.reciters.join(', ')}]`);
  if (filter.riwayah) parts.push(`riwayah = ${filter.riwayah}`);
  if (filter.page !== undefined) parts.push(`page = ${filter.page}`);
  return parts.length ? parts.join(', ') : 'EVERY cached clip (no filter)';
}

async function main(): Promise<void> {
  const filter = parseFilter();
  const confirmed = argv.includes('--yes');

  const matched = await countCachedPageAudio(filter);
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

  const deleted = await clearCachedPageAudio(filter);
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
