# Working on Tilawah (a guide for new developers)

This is a friendly, plain English guide to help you (human or AI) get productive
in this repo fast. It does not replace `CLAUDE.md`, which has the deep detail and
the rules. Read this first, then dip into `CLAUDE.md` for the part you touch.

No em dashes on purpose. Easy words on purpose.

## 1. What Tilawah is, in one minute

Tilawah is a Telegram bot that sends a daily Quran "wird" (a reading portion)
measured in Mushaf pages. It serves two kinds of reader from ONE engine:

- A public CHANNEL that posts the daily portion to everyone who follows it. An
  admin sets the pace. The channel moves forward every time it posts.
- Individual USERS in private chat. Each user gets one page a day by default and
  can raise it up to 20 pages (one juz). Each user picks their own days, time,
  and timezone, and can take a break and come back.

The key trick: a channel is just a special subscriber row (`kind = "channel"`).
The send engine is written once and both kinds flow through it.

With a user's wird the bot also sends the page recitation (silent) and a small
"read ✓" button. A user moves forward ONLY when they press that button (or type
`/next`). A missed day never skips pages. We call this "read gated". The channel
is different: it moves on every post.

## 2. Run it on your machine

You need: Node 20+, pnpm, and a MySQL or MariaDB database.

```bash
pnpm install                 # install packages
cp .env.example .env         # then fill in BOT_TOKEN and the database URL
pnpm data:fetch              # download + verify the Quran text + page map (once)
pnpm db:deploy               # create the tables
pnpm db:seed                 # fill the Quran pages and reference data
pnpm dev                     # run the bot with reload
```

Useful while developing:

```bash
pnpm test          # run all tests (vitest)
pnpm typecheck     # type errors only
pnpm lint          # eslint
pnpm check         # typecheck + lint + test (run this before you push)
pnpm db:studio     # browse the database in the browser
```

There is ONE `.env` at the repo root. Code finds it on its own, so you can run a
command from any folder.

Note: the channel is optional. The personal user bot and the channel are each
turned on by config, so you can develop with just the user side.

## 3. Where the code lives

```
src/core        pure logic. No database, no network. Easy to test.
src/database     the Prisma client, the services (all DB reads/writes), reference data.
src/lib          the glue: message text (copy.ts), the send wrappers, keyboards, deliver.ts.
src/bot.ts       the grammY bot: every command and every button handler.
src/scheduler.ts the once-a-minute job that runs the daily send.
prisma/          the schema, migrations, and the seed script.
```

A good rule: keep thinking in `core` (pure, tested), keep talking to the
database in `database/services`, and keep Telegram in `bot.ts` and `lib`.

Some `core` files (schedule, days, arabic, env) and `lib/{send,logger}` are tiny
re-exports from a shared package called `telegram-bot-kit`. To change that shared
code you edit the kit, not here. See `CLAUDE.md` for how.

## 4. The core idea: advance differs by kind

This is the heart of the bot. Learn it once and the rest makes sense.

- Each subscriber has a `currentPage` (where they are now).
- CHANNEL: advance on send. When it posts, the record carries the next page, so
  the position moves with the post. A partial send moves only by the pages that
  actually went out.
- USER: advance on READ. The daily send shows the wird and RECORDS the day, but
  it does NOT move `currentPage`. So the same wird comes back tomorrow until the
  user confirms. They confirm with the "read ✓" button or `/next`. Both call
  `advanceAndShowNext`, which confirms the current wird, moves forward, and shows
  the next wird (with its own button).
- One wird per local day per subscriber is enforced by a unique index
  `(subscriberId, scheduledFor)` on `DeliveryLog`. Do not work around it.

A brand-new user (one who has never received a wird, `startedAt` is null) who
types `/next` SEES their current wird first, without advancing, so the first wird
is never skipped. After that, `/next` advances normally.

## 5. How the daily send works (the happy path)

`deliverDueSubscribers` in `src/lib/deliver.ts` runs every minute. For each
active, not blocked subscriber:

1. Is it their time today, in their own timezone and active days? If not, skip.
2. Already delivered today? If yes, skip.
3. Build the wird (their pages) and, for a user who is behind, a gentle nudge.
4. Send the daily tajweed lesson (best effort), then the wird, page by page.
5. Record the day. The channel advances here; a user does not.
6. Send the page recitation (silent). For a user, send the "read ✓" button.

One subscriber failing is caught and never stops the others. Text or image is
per user (`wirdFormat`). Images go as albums and fall back to text if a page has
no source, so the holy text always gets through.

## 6. Two extra ideas you will meet

- Buttons carry an id. The "read ✓" button is `tilawah:read:<startPage>`. A tap
  on an old button (from a wird the reader already passed) is a gentle no-op. The
  on-demand "🎧 الاستماع" button is pinned the same way to the wird its message
  showed.
- Progressive disclosure. The daily send pushes the recitation for you. But a
  `/next` reveal, or a `/today` re-show, does NOT. Instead it offers a small
  "listen" button to pull the recitation on demand. This keeps the screen clean
  for a fast reader and still gives the audio to whoever wants it.

## 7. How to make a change safely

1. Read the part of `CLAUDE.md` that covers what you touch.
2. Put pure logic in `core` and write a test for it.
3. Put DB work in a service in `database/services`.
4. User facing words go in `src/lib/copy.ts`, never inline in handlers.
5. Telegram text is sent as PLAIN text, never Markdown or HTML. Quran characters
   break parsed messages with a 400. See `src/lib/send.ts`.
6. Remember the two kinds. If you change the user flow, check the channel is not
   affected (all user entry points require a private chat and a user row).
7. Run `pnpm check`. Keep it green.
8. Small, focused commits. Do not add a `Co-Authored-By` line.

### Common small tasks

- Change a message: edit `src/lib/copy.ts`. Look for the `COPY` object.
- Add a command: add a `bot.command('name', ...)` handler in `src/bot.ts`, and a
  menu entry where the commands are set (same file).
- Add a button: pick a unique callback string (namespaced like `tilawah:thing`),
  build it in a keyboard, and add a `bot.callbackQuery(...)` handler. Always call
  `ctx.answerCallbackQuery()` so the spinner clears.
- Change the schema: edit `prisma/schema.prisma`, then `pnpm db:migrate` to make
  a migration, and commit the new folder under `prisma/migrations/`.

## 8. Golden rules you must not break

1. Never type Quran text by hand. It only comes from the fetch script, which
   verifies it against a trusted source.
2. Keep `core` pure (no database, no network).
3. Plain text only when sending (no parse_mode).
4. For a USER, advance the position only on a confirmed read, never on a send.
   For the CHANNEL, advance on send.
5. One wird per subscriber per local day. The unique index is the lock.

If something here ever disagrees with the code, the code and `CLAUDE.md` win.
Please fix this guide when you notice that.
