# Tilawah

Tilawah is a Telegram bot that sends a daily Quran reading portion (a "wird"),
measured in pages of the standard Madani Mushaf. It can post to a public
channel, serve individual users in private chat, or do both. The user facing
text is in Arabic.

This README is in easy English with no em dashes, so a newcomer can run and
extend the project.

## What it does

- Sends a daily wird of one or more Mushaf pages.
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
design notes, `docs/DEPLOY.md` to run it, `docs/BOTFATHER.md` for the bot's
name, about, description, and commands, and `docs/CHANNEL.md` for the channel
name, description, and pinned welcome post.

## The Quran data

The text is the Tanzil Uthmani edition (https://tanzil.net). The page numbers
(604 pages) and juz numbers (30) are the standard Madani Mushaf boundaries from
the Al Quran Cloud metadata. Both are downloaded once with `pnpm data:fetch`,
verified hard (6236 ayat, correct count per surah, 604 pages, 30 juz, and the
well known anchors), and frozen to a committed file. The app never edits the
Quran tables after seeding, and it refuses to start if the data is incomplete.
See `NOTICE` for the source and license.

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

All in Arabic. `/today` read now, `/wird` pages per day, `/time` send time,
`/days` send days, `/timezone` timezone, `/pause` take a break or come back,
`/status` your settings, `/help` help.

## Admin commands (channel)

Private chat, admins only. `/admin_setpage N` set the last page read (the
channel resumes at N+1), `/admin_wird N` pages per day, `/admin_time HH:MM`
post time, `/admin_tz Area/City` timezone, `/admin_pause` pause or resume,
`/admin_status` channel status, `/admin_send` send the batch now.

## Development

```bash
pnpm test     # all tests
pnpm check    # typecheck + lint + test, run before pushing
```

License: 0BSD (see `LICENSE`). The bundled Quran text is under the Tanzil terms
of use (see `NOTICE`).
