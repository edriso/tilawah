# Tilawah

Tilawah is a Telegram bot that sends a daily Quran reading portion (a "wird"),
measured in pages of the standard Madani Mushaf. It can post to a public
channel, serve individual users in private chat, or do both. The user facing
text is in Arabic.

This README is in easy English with no em dashes, so a newcomer can run and
extend the project.

## What it does

- Sends a daily wird of one or more Mushaf pages.
- Each page is sent as a picture of the Madani Mushaf page by default (when a
  page-image source is configured), or as plain text. Readers switch with
  `/format`, the channel admin with `/admin_format`. If an image is missing the
  bot quietly sends that page as text, so a wird always arrives. See
  `docs/DEPLOY.md` for the image source and self-hosting.
- Sends an audio recitation of each page after the wird (on by default), from a
  trusted source (everyayah.com). The reciter is chosen with `/reciter` (Abdul
  Basit by default, plus Husary, Alafasy, As-Sudais, Al-Minshawi) or turned off;
  each page/reciter clip is fetched once then re-sent by cached file_id. The
  recitation is silent (no second notification sound), a quiet companion to the
  wird that already arrived. It always follows the wird the reader just got, on
  the scheduled send, `/today`, and `/page` alike: change the page count, the
  page, or the reciter and the very next send recites the right pages in the
  right voice (picking a reciter also turns the audio back on). After picking a
  voice, a "جرّب على صفحة اليوم" button lets the reader hear it right away on
  one page of today's wird (a silent peek that does not re-deliver anything).
- `/tafsir` gives a link to read the tafseer of today's wird pages: one button
  per page opening that Mushaf page on quran.com, where every ayah's tafsir is a
  tap away. Link-only (no stored text), and it always follows the reader's
  current wird (size and page).
- Posts a short daily tajweed lesson right before the wird (on by default), so
  readers learn to recite correctly a rule at a time. Each lesson has a plain
  explanation, an example ayah (verified text from the database), and an optional
  recitation clip. The lessons run in order from the first one and repeat when
  finished. Readers toggle it with `/tajweed`, the channel admin with
  `/admin_tajweed`. The `/tajweed` message also has a "📚 كل دروس التجويد"
  button that opens the full lessons library: a paginated list to browse and tap
  any rule you want to learn now, without changing your daily lesson order.
- A public channel posts the daily portion to everyone who follows it. An admin
  sets the last page read and the bot continues from the next page.
- Each user can set how many pages a day (1 to 20), which days, what time, and
  their timezone, and can take a break and resume from the same page.
- The whole Quran loops: after page 604 it starts again at page 1.

## How it is built

One small TypeScript project, everything under `src/`:

- `src/core` pure logic with no database or network: the page and wird
  math, the schedule math, and the message building. Fully unit tested.
- `src/database` the Prisma client and the database services.
- `src/` (bot.ts, scheduler.ts, lib/, ...) the grammY bot and the once a
  minute scheduler. `prisma/` holds the schema, migrations, and seed;
  `scripts/` holds the data fetch.

A channel is just a subscriber with `kind = "channel"`, so the send engine is
written once and serves both the channel and users. See `CLAUDE.md` for the
design notes, `docs/DEPLOY.md` to run it, and `docs/CHANNEL.md` for the channel
name, description, and pinned welcome post.

## The Quran data

The text is the Tanzil Uthmani edition (https://tanzil.net). The page numbers
(604 pages) and juz numbers (30) are the standard Madani Mushaf boundaries from
the Al Quran Cloud metadata. Both are downloaded once with `pnpm data:fetch`,
verified hard (6236 ayat, correct count per surah, 604 pages, 30 juz, and the
well known anchors), and frozen to a committed file. The app never edits the
Quran tables after seeding, and it refuses to start if the data is incomplete.
See `NOTICE` for the source and license.

For the image format, the 604 page images are likewise a verified asset,
self-hosted per riwayah under its own subfolder (`assets/mushaf/hafs/`,
`assets/mushaf/qaloon/`, ...). Each set is prepared and integrity-checked with
`pnpm data:mushaf` — downloaded from a URL, or imported from a local render with
`--from-dir` (the shipped Hafs set is the official KFGQPC مصحف المدينة 1440H
rendered from the verified PDF). It writes a tracked per-riwayah SHA-256
manifest, re-verified with `pnpm data:mushaf --check --out assets/mushaf/<riwayah>`.
The images themselves are not committed; see `docs/DEPLOY.md`.

## Quick start

You need Node 20+, pnpm, and a MySQL or MariaDB database.

```bash
pnpm install
cp .env.example .env       # then fill in BOT_TOKEN and DATABASE_URL
pnpm data:fetch            # download + verify the Quran data (already committed, optional)
pnpm db:deploy             # create the tables
pnpm db:seed               # fill the Quran tables
pnpm dev                   # run the bot
```

Set `CHANNEL_CHAT_ID` to run the channel and `ADMIN_TELEGRAM_IDS` to control
it. Set `USER_WIRD_ENABLED=false` for a channel only deployment. See
`.env.example` for every option, and `docs/DEPLOY.md` for production.

## User commands

All in Arabic. `/today` read today's wird now (counts as today's), `/wird` pages
per day, `/tajweed` the daily tajweed lesson (read it now, or toggle on/off with
`/tajweed on|off`), `/reciter` the page-recitation voice (pick a reciter or off),
`/tafsir` a link to read today's wird pages' tafseer on quran.com,
`/format` text or Mushaf-page image, `/page` go to a specific
page (1 to 604) and read it now, `/time` send time, `/days` send days,
`/timezone` timezone, `/pause` take a break or come back, `/status` your
settings, `/help` help.

## Admin commands (channel)

Private chat, admins only. `/admin_setpage N` set the last page read (the
channel resumes at N+1), `/admin_wird N` pages per day, `/admin_time HH:MM`
post time, `/admin_tz Area/City` timezone, `/admin_pause` pause or resume,
`/admin_format text|image` how the channel posts (text or Mushaf-page image),
`/admin_tajweed on|off` the channel's daily tajweed lesson, `/admin_reciter
<off|key>` the channel's recitation voice, `/admin_review` get
the whole tajweed deck as a document to review or forward to a scholar,
`/admin_status` channel status, `/admin_send` send the batch now.

## Development

```bash
pnpm test     # all tests
pnpm check    # typecheck + lint + test, run before pushing
```

License: 0BSD (see `LICENSE`). The bundled Quran text is under the Tanzil terms
of use (see `NOTICE`).
