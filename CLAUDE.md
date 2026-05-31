# CLAUDE.md

Notes for anyone (human or AI) working in this repo. Easy English on purpose,
no em dashes, so a junior developer can read this and be productive.

## What this is

Tilawa is a Telegram bot that sends a daily Quran "wird" (a daily reading
portion) measured in Mushaf pages. It serves two kinds of reader from one
engine:

- A public channel that posts the daily portion to everyone who follows it.
  An admin controls it and can set the last page that was read, so the bot
  continues from the next page.
- Individual users in private chat. Each user gets one page a day by default
  and can raise it up to 20 pages (one juz). Each user picks their own days,
  time, and timezone, and can take a break and resume.

The key idea: a channel is just a special subscriber (a row with
`kind = "channel"`). The send engine is written once and both the channel and
the users flow through it. We never write the schedule logic twice.

It is a pnpm workspace:

- `packages/core` pure logic, no database, no network. Fully unit tested.
- `packages/database` Prisma schema, the client, and services.
- `apps/telegram` the grammY bot: commands and the daily scheduler.

Read `docs/DEPLOY.md` to run it, and `docs/BOTFATHER.md` to set up the bot in
@BotFather.

## Golden rules

1. Never type Quran text, page numbers, or juz numbers by hand. They only come
   from `pnpm data:fetch` (Tanzil Uthmani text plus the Madani Mushaf page and
   juz boundaries), and every value is verified before it is written. The
   Surah and Ayah tables are read only after seeding.
2. Keep `core` pure. No database or network imports there. That is what keeps
   it easy to test.
3. The bot sends plain text, never Markdown or HTML parse_mode. Quran text
   would make a parsed message fail with a 400. See `apps/telegram/src/lib/send.ts`.
4. Advance a subscriber's page ONLY after a real send. A failed send must
   retry the same pages, never skip them.
5. One wird per subscriber per local day. The `unique(subscriberId,
   scheduledFor)` index on `DeliveryLog` is the lock. Do not work around it.

## How a wird is measured

- A page is one page of the standard Madani Mushaf (604 pages total).
- Each `Ayah` row carries its `page` (1 to 604) and `juz` (1 to 30). Fetching
  one page is a simple query on `page`.
- A wird of N pages starting at page P is pages P, P+1, ... wrapping from 604
  back to 1. See `pagesForWird` and `advanceStartPage` in
  `packages/core/src/wird.ts`.
- Default wird is 1 page a day. The max a user can pick is 20 pages
  (`MAX_WIRD_PAGES`), which is about a juz a day and finishes the Quran in
  about a month. We cap there on purpose: scholars caution against finishing
  the whole Quran in under three days.

## How the daily send works

`deliverDueSubscribers` (in `apps/telegram/src/lib/deliver.ts`) runs every
minute. For each active, non-blocked subscriber of an allowed kind:

1. `dueLocalDate` checks their own timezone, send time, and active days.
2. If already delivered for that local date, skip.
3. Take the next N pages from `currentPage` (N is `wirdSize`), wrapping at 604.
4. Build the Arabic message(s), one per page.
5. Send them.
6. On success, record the delivery and move `currentPage` forward by N, in one
   transaction.

One subscriber failing is caught and never stops the rest of the batch.

## Channel and users are optional

Config decides what runs (see `.env.example`):

- Set `CHANNEL_CHAT_ID` to run the channel. `ADMIN_TELEGRAM_IDS` lists who can
  control it with the `/admin_*` commands.
- `USER_WIRD_ENABLED` (default true) turns the personal bot on or off. When
  off, the bot politely declines personal commands and the scheduler serves
  the channel only.

The database is always required, because both the channel and users keep their
place in it. The bot fails fast at boot if `DATABASE_URL` is missing or the
Quran data is not fully seeded.

## Conventions

- TypeScript, ESM, strict mode.
- Prisma models are PascalCase, fields camelCase, with `@map`/`@@map` to
  snake_case tables and columns. We do not use Prisma enums; a short string
  field with a comment listing the allowed values is enough (for example
  `kind` is "user" or "channel").
- Comments explain WHY, not what. Match the density already in the files.
- Tests use vitest. Add tests for new logic, including edge cases.
- Arabic text lives in `apps/telegram/src/lib/copy.ts`. It is right to left;
  wrap any left to right run (a command, a time, a timezone) with the `ltr()`
  helper so the punctuation around it does not reorder.

## Common commands

```bash
pnpm install
pnpm data:fetch     # download + verify the Quran text, pages, and juz (once; also committed)
pnpm db:deploy      # apply migrations (create tables)
pnpm db:seed        # fill the Quran tables
pnpm dev            # run the bot with reload
pnpm test           # all tests
pnpm check          # typecheck + lint + test (run before pushing)
pnpm db:studio      # browse the database
```

### Changing the schema

Edit `packages/database/prisma/schema.prisma`, then make a migration:

```bash
pnpm db:migrate     # prisma migrate dev: creates a new migration and applies it
```

Commit the new folder under `prisma/migrations/`. Production applies it with
`pnpm db:deploy`.

## Gotchas

- There is ONE `.env`, at the repo root. Every package and script loads it
  through `loadEnv()` in `packages/core/src/env.ts`, which finds the root (the
  folder with `pnpm-workspace.yaml`) no matter where the command runs.
  `prisma.config.ts` has the same loader inline.
- `NODE_ENV` defaults to `production`. `pnpm dev` sets `NODE_ENV=development`
  itself, so local work always runs in development mode no matter what `.env`
  says.
- Prisma 7 does not read `.env` on its own and does not take the URL in the
  schema. The CLI gets the URL from `prisma.config.ts`; the running bot builds
  its own client in `src/client.ts`.
- The generated Prisma client lives in `packages/database/src/generated`. It
  is git ignored. Run `pnpm db:generate` if imports from it fail.
- `activeDays` is a 7-bit mask (bit 0 = Monday). Use the helpers in
  `packages/core/src/days.ts`, do not do bit math by hand elsewhere. The day
  picker shows days Saturday first (the order Arabic readers expect), but the
  stored mask is still ISO (Monday = 1). Only the display order differs; see
  `WEEKDAY_DISPLAY_ORDER` in copy.ts.
- Timezone and page math always take `now` (or the inputs) as arguments so they
  can be tested. Do not call `new Date()` deep inside pure functions.
- The channel chat id can be a numeric id or a public @username in `.env`. It
  is resolved to a numeric id once at startup and stored on the channel
  subscriber row.

## Where things live

- Page and wird math: `packages/core/src/wird.ts`
- Message building (one message per page): `packages/core/src/format.ts`
- Surah names and revelation: `packages/database/src/reference/surahs.ts`
- Ayah count oracle: `packages/database/src/reference/ayah-counts.ts`
- Page and juz constants and anchors: `packages/database/src/reference/pages.ts`
- Message wording (Arabic): `apps/telegram/src/lib/copy.ts`
- The send engine: `apps/telegram/src/lib/deliver.ts`
