# Riwayat (Warsh, Qaloon, ...) — design and build plan

This is the build blueprint for letting a reader follow the daily wird in a
riwayah other than Hafs (the community ask from the إتقان thread: Warsh عن نافع
من طريق الأصبهاني, and the reciter محمد عبدالكريم). It is the RECOMMENDED home
for this feature: the sister `ayah` bot cannot do it (its unit is one ayah, and
no per-ayah non-Hafs audio exists — see ayah's `docs/RIWAYAT.md`), but tilawah
can, because its unit is the **Mushaf page**, and the page-level data DOES exist.

Read `CLAUDE.md` (golden rules) first. Rule #1 is the spine of this whole doc:
**never type Quran text, page, or juz numbers by hand** — every value is fetched
from a verified source and checked before it is written. That applies to every
riwayah we add, exactly as it does to Hafs today.

## Why tilawah fits and ayah does not

The deliverable gates on one thing: the AUDIO/CONTENT unit must match the
DELIVERY unit.
- ayah delivers one **ayah**/day -> needs per-ayah audio -> none exists for the
  requested riwayah/reciters (only per-surah / per-page).
- tilawah delivers one **page**/day (image + page audio) -> needs per-page
  assets -> these exist for Warsh, including the exact Asbahani reciter asked for,
  pre-split to the 604-page Madinah layout tilawah already uses.

## Product model (simple, image-first, best UX)

- **Riwayah is the parent choice; the reciter is filtered by it; the mushaf
  (image + text + page map) follows it.** Default riwayah = `hafs`. Nothing
  changes for any existing reader or the channel until they opt in.
- A reader sets it with **/riwayah** (and a /settings shortcut). Picking a
  non-Hafs riwayah:
  - switches the page IMAGES and (text format) the TEXT to that riwayah,
  - resets the reciter to that riwayah's default and notes it,
  - keeps the SAME page number (1..604) — all the shipped qiraat use the
    604-page Madinah grid, so "you are on page N" carries across cleanly.
- **/reciter** lists only the chosen riwayah's reciters, with a one-line note
  ("القُرّاء المعروضون برواية ...").
- Keep it image-first: a non-Hafs reader defaults to the IMAGE format (the
  verified Warsh page), which is the strongest, simplest experience and avoids
  the tafseer/numbering complications of text. Text format stays available.

## Trusted data sources (all KFGQPC-derived)

The authoritative origin for every riwayah's text, rasm, page and juz layout is
the **King Fahd Complex (KFGQPC)** developer platform:
https://qurancomplex.gov.sa/quran-dev/ (per-narration data: jozz, page, sura,
verse; CSV/JSON/SQL/XML). Warsh landing: https://qurancomplex.gov.sa/en/warsh/.
We use these open, KFGQPC-sourced datasets and CROSS-CHECK them (two independent
oracles per value, like Hafs text is cross-checked today):

- **Text per riwayah (6214 for Warsh/Qaloon, Madani count):**
  https://github.com/Ishaksmail/QuranJSON (Hafs, Warsh, Qaloon, Douri, ... from
  KFGQPC originals). Second oracle for Warsh text: KSU Electronic Mushaf
  (https://quran.ksu.edu.sa/) Warsh edition.
- **Page + juz + ruku map per riwayah:**
  https://github.com/quran-center/quran-meta ("Hafs, Qalun, Warsh are ready";
  juz/page/ruku lookups). This is the per-riwayah equivalent of what
  `scripts/fetch-quran.ts` fetches for Hafs (604 pages, 30 juz).
- **Page IMAGES per riwayah (604 pages, Madinah layout):**
  KFGQPC masters via https://pdf.quran.ws/ (Warsh 6214/604, Qaloon 6214/604), and
  https://github.com/quranpedia/quran-svg (per-page SVG + ayah-polygon JSON for
  Hafs/Warsh/Qalun/Douri/Shubah). Either rasterizes to the `{page3}.jpg` set the
  bot uploads. KFGQPC's own Warsh PDF: https://archive.org/details/quran-warsh-pdf.
- **Per-page AUDIO per riwayah (604-page Madinah split):** the requested
  محمد عبدالكريم, Warsh من طريق الأصبهاني, complete 604 pages:
  https://archive.org/details/2435724525242002_yahoo_001 (also عبد الكبير الحديدي).
  mp3quran.net has a Warsh-Asbahani category for alternates.

VERIFICATION (golden rule): every fetched set is checked before it is written —
counts (6214 ayat for Warsh, per-surah counts, 604 pages, 30 juz), a second
oracle agreeing on the text, and for assets an integrity/manifest pass (the
existing `data:mushaf` and `verify:audio` style). The archive.org audio is a
community upload, so it gets the STRICTEST pass: confirm 604 files, each a valid
MP3 over a min size, and spot-check that page N's clip recites page N of the SAME
604-page Warsh Madinah edition the images use. We pin ONE edition across text,
images, audio, and the page map (there is also a ~573-page photographed Warsh
print — do NOT mix it with the 604-page layout).

## Schema changes (additive, default 'hafs', non-destructive)

A `riwayah` short string (no Prisma enum, per convention), defaulting to `hafs`
so the migration is a no-op for every existing row:

- `Ayah`: add `riwayah String @default("hafs")`. The unique key becomes
  `@@unique([riwayah, surahNumber, numberInSurah])` and the hot index
  `@@index([riwayah, page])`. Hafs rows keep working; Warsh rows are seeded
  alongside (6214 of them).
- `Subscriber`: add `riwayah String @default("hafs")`. Drives which text/images/
  audio/reciters they get.
- `MushafPageImage`: PK becomes `@@id([riwayah, page])` (a Warsh page 25 is a
  different image from a Hafs page 25).
- `PageAudio`: PK becomes `@@id([riwayah, page, reciter])`.
- The startup seed-guard (`assertQuranSeeded`) checks counts PER seeded riwayah,
  and the bot only OFFERS a riwayah whose data + assets are present (an
  `availableRiwayat()` check, mirroring ayah's `assertTracksSeeded`), so a
  half-seeded riwayah can never reach a reader.

## New reference + core

- `src/core/riwayah.ts`: the registry `{ key, nameAr, routeAr, ayahCount,
  countingSchool }`, `DEFAULT_RIWAYAH = 'hafs'`, `isRiwayah` / `normalizeRiwayah`.
  Pure, fully unit-tested. `hafs` (6236, Kufi) and `warsh-asbahani` (6214, Madani)
  to start.
- `src/core/reciter.ts`: each reciter gains a `riwayah`; add `recitersFor(riwayah)`
  and a per-riwayah default. Existing Hafs reciters are tagged `hafs` (no behaviour
  change). Warsh reciters (e.g. `abdulkarim`) are tagged `warsh-asbahani`.

## Config / env (per-riwayah asset templates)

- `MUSHAF_IMAGE_BASE_URL` and `PAGE_AUDIO_BASE_URL` gain an optional `{riwayah}`
  placeholder, so one template serves all:
  `/app/assets/mushaf/{riwayah}/{page3}.jpg`,
  `/app/assets/page-audio/{riwayah}/{folder}/Page{page3}.mp3`.
  Hafs stays at its current path (back-compatible: `{riwayah}` is optional and
  resolves to `hafs`).

## Server / asset hosting (Hetzner)

Per the server repo convention (big runtime files live OUTSIDE the code, in
`/opt/bots/data/<repo>/<kind>`, bind-mounted read-only; see
hetzner-cloud-server `templates/compose-with-assets.yml`):
- `/opt/bots/data/tilawah/mushaf/hafs/` (today) and `/.../mushaf/warsh-asbahani/`.
- `/opt/bots/data/tilawah/page-audio/hafs/...` and `/.../warsh-asbahani/...`.
Build + verify locally, rsync up, then start. Roll out one riwayah/reciter at a
time; a missing asset already falls back gracefully (image -> text; page-audio ->
everyayah for Hafs; for a non-Hafs page with no asset, skip audio rather than
serve the wrong riwayah).

## Scripts (riwayah-aware, mirroring the existing ones)

- `data:fetch --riwayah warsh-asbahani`: fetch + verify Warsh text + page/juz map
  from the trusted sources above (counts + second oracle), write
  `prisma/data/quran-warsh-asbahani.json`, seed its `Ayah` rows.
- `data:mushaf --riwayah warsh-asbahani`: fetch + integrity-check the 604 Warsh
  page images into the per-riwayah folder.
- `data:page-audio --riwayah warsh-asbahani --reciter abdulkarim`: assemble +
  verify the per-page set (or ingest the 604-page archive.org split with the
  strict verification above).
- `verify:audio` / a new `verify:images`: confirm a riwayah's set is complete.

## Engine wiring (small, localized)

The Ayah queries (the page lookup, the wird builder, captions) and the
image/audio resolvers all take the subscriber's `riwayah`. Because everything is
keyed by page (1..604) and the page count is identical across riwayat, the
scheduler, the read-gated advance, idempotency, and the channel are UNCHANGED;
only "which rows/assets for this page" gains a riwayah filter.

## Tafseer / numbering note

Non-Hafs uses the Madani count (6214). Any feature keyed to Kufic numbering
(e.g. a future tafseer) is OFF for non-Hafs until a verified Madani<->Kufic
bridge exists. The wird itself (page image + page audio + page text) needs no
such bridge: it is page-native.

## Staged rollout

1. **Core + schema (no data):** `riwayah.ts` + reciter grouping + the additive
   migration (defaults `hafs`). Fully unit-tested; live bot unaffected.
2. **Warsh data:** the riwayah-aware `data:fetch`; seed Warsh `Ayah` rows;
   per-riwayah seed guard. Verified against two oracles.
3. **Warsh assets:** images + page audio (محمد عبدالكريم Asbahani), verified and
   self-hosted on the server.
4. **Engine wiring:** riwayah filter through the Ayah queries and asset resolvers.
5. **UX:** `/riwayah` picker, `/reciter` filtered by riwayah, switch-resets-reciter,
   /settings line. Copy in Arabic, plain text (no parse_mode).
6. **Qaloon / more reciters:** pure data + asset additions, no code change.

Each stage is shippable and reversible, and the channel + every Hafs reader keep
working untouched throughout.

## Build status

Shipped and deployed (each Hafs-identical and non-breaking):

- **A — Warsh dataset** (`prisma/data/quran-warsh-asbahani.json`, 6214, verified
  KFGQPC + quran-meta). `pnpm data:fetch:warsh`.
- **B — schema + per-riwayah seed/services + reciter grouping** (migration
  `20260623000000_add_riwayah`, default `hafs`; verified on populated tables).
- **C — riwayah-aware send engine** ({riwayah} in the image/audio templates, with
  the guard that a non-Hafs reader is never served a Hafs asset).
- **D — UX:** `/riwayah` picker, `/reciter` filtered by riwayah, switch-resets-
  reciter, `/status` line, the Warsh reciter محمد عبد الكريم registered. Gated by
  `offeredRiwayat()`.

The remaining work to actually turn Warsh ON is operational (Stage E below): host
the verified Warsh assets and point the templates at them. Until then,
`offeredRiwayat()` returns `['hafs']` (the image template has no `{riwayah}`), so
Warsh is invisible and the bot is exactly as before.

## Stage E — operator runbook (turn Warsh on)

No code change is needed. Two machines are involved, and it matters which is
which:

- **Your laptop** (has the tilawah repo + pnpm/node): steps 1–2 + 4. The `pnpm`
  commands run HERE, never on the server. The existing `data:mushaf` and
  `verify:audio` tools already take the riwayah via `--source` / `--out` / `--dir`.
- **The server** (Docker only, no pnpm): steps 3, 5, 6. Pure shell + `docker compose`.

Prerequisite: this layout self-hosts EVERY riwayah's assets under a `{riwayah}`
subfolder, so Hafs is self-hosted too. If your production image/audio source is
currently a remote URL (not a local `/app/assets/...` path), self-host Hafs first
(`pnpm data:mushaf` / `pnpm data:page-audio`) before enabling Warsh. Check your
current values on the server with:
`docker compose exec tilawah printenv MUSHAF_IMAGE_BASE_URL PAGE_AUDIO_BASE_URL`.

1. **[laptop] Get + verify the Warsh page images (604).** Render a verified KFGQPC Warsh
   Madani set (vector pages from https://pdf.quran.ws/ or the SVGs in
   quranpedia/quran-svg) to `001.jpg`..`604.jpg`, then fingerprint them:

       pnpm data:mushaf --source '<warsh-image-url-template-with-{page3}>' \
                        --out assets/mushaf/warsh-asbahani
       # eyeball a few pages: they must be the 604-page Madinah Warsh edition

2. **[laptop] Get + verify the Warsh page audio (604).** Download محمد عبد الكريم's
   604-page Madinah Warsh-Asbahani set
   (https://archive.org/details/2435724525242002_yahoo_001) to
   `assets/page-audio/warsh-asbahani/AbdulKareem/Page001.mp3`..`Page604.mp3`,
   then confirm it is complete + every file is a real MP3:

       pnpm verify:audio --dir assets/page-audio/warsh-asbahani/AbdulKareem
       # spot-check: play a few pages and confirm they recite THAT page (Warsh)

   It is a community upload, so this verification is the trust gate (golden rule).

3. **[server] Relocate the existing Hafs assets into a `hafs/` subfolder** (the templates
   below namespace EVERY riwayah, so Hafs moves too — one-time):

       cd /opt/bots/data/tilawah
       mkdir -p mushaf/hafs && mv mushaf/[0-9]*.jpg mushaf/hafs/
       # page-audio: mushaf reciters move under page-audio/hafs/<folder>/
       mkdir -p page-audio/hafs && mv page-audio/*/ page-audio/hafs/ 2>/dev/null || true

4. **[laptop] Rsync the Warsh assets up:**

       rsync -av assets/mushaf/warsh-asbahani/      root@<SERVER_IP>:/opt/bots/data/tilawah/mushaf/warsh-asbahani/
       rsync -av assets/page-audio/warsh-asbahani/  root@<SERVER_IP>:/opt/bots/data/tilawah/page-audio/warsh-asbahani/

5. **[server] Add `{riwayah}` to the templates** in `/opt/bots/.env` (or tilawah's env):

       MUSHAF_IMAGE_BASE_URL=/app/assets/mushaf/{riwayah}/{page3}.jpg
       PAGE_AUDIO_BASE_URL=/app/assets/page-audio/{riwayah}/{folder}/Page{page3}.mp3

   Confirm the volume mounts cover `mushaf/` and `page-audio/` parents (they do
   if you mount those dirs; see hetzner `templates/compose-with-assets.yml`).

6. **[server] Recreate the bot** so it picks up the new env (a restart will not reload it):

       cd /opt/bots && docker compose up -d tilawah
       docker compose exec tilawah ls assets/mushaf/warsh-asbahani | head   # confirm visible

Once step 5 lands, `offeredRiwayat()` returns `['hafs','warsh-asbahani']`,
`/riwayah` appears, and a reader can switch. Roll back any time by removing
`{riwayah}` from the templates (Warsh hides again instantly; data stays).

6'. **(Future) Qaloon / more Warsh reciters:** pure data + asset additions — seed
   the riwayah's text, host its assets under its own subfolder, register the
   reciter in `reference`/`reciter.ts`. No engine change.

## Sources
- KFGQPC dev platform — https://qurancomplex.gov.sa/quran-dev/
- KFGQPC Warsh — https://qurancomplex.gov.sa/en/warsh/  | PDF — https://archive.org/details/quran-warsh-pdf
- Text per riwayah — https://github.com/Ishaksmail/QuranJSON
- Page/juz map per riwayah — https://github.com/quran-center/quran-meta
- Page images (SVG, multi-qiraat) — https://github.com/quranpedia/quran-svg  | vector — https://pdf.quran.ws/
- Per-page Warsh-Asbahani audio (محمد عبدالكريم, 604) — https://archive.org/details/2435724525242002_yahoo_001
- KSU Electronic Mushaf (Warsh second oracle) — https://quran.ksu.edu.sa/
- Counting schools (Kufic 6236 vs Madani 6214) — islamweb fatwa 75878
