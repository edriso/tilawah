# CLAUDE.md

Notes for anyone (human or AI) working in this repo. Easy English on purpose,
no em dashes, so a junior developer can read this and be productive.

## What this is

Tilawah is a Telegram bot that sends a daily Quran "wird" (a daily reading
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

It is one small TypeScript project, with everything under `src/`:

- `src/core` pure logic, no database, no network. Fully unit tested.
- `src/database` the Prisma client and the database services.
- `src/` (bot.ts, scheduler.ts, lib/, ...) the grammY bot: commands and the
  daily scheduler. `prisma/` holds the schema, migrations, and seed; `scripts/`
  holds the data fetch.

The cross-bot kernel lives in **`telegram-bot-kit`** (a separate public repo,
pinned by git tag in `package.json`): the timezone/schedule math, the active-day
bitmask, Arabic-Indic digits, the root `.env` loader, the logger, and the
plain-text send wrapper. The matching files here (`src/core/schedule.ts`,
`days.ts`, `arabic.ts`, `env.ts`; `src/lib/send.ts`, `logger.ts`) are one-line
re-export shims, so existing imports of `../core` / `./send` / `./logger` keep
working while the code lives (and is tested) once, in the kernel. To change that
code: edit the kernel, `pnpm check`, tag a new version, and merge the Renovate
bump PR it opens here. The ayah bot consumes the same kernel.

Read `docs/DEPLOY.md` to run it and `docs/CHANNEL.md` for the channel (name,
description, and the paste-ready pinned welcome post).

## Golden rules

1. Never type Quran text, page numbers, or juz numbers by hand. They only come
   from `pnpm data:fetch` (Tanzil Uthmani text plus the Madani Mushaf page and
   juz boundaries), and every value is verified before it is written. The
   Surah and Ayah tables are read only after seeding. The page IMAGES (the image
   format) are Quran content too: use only a VERIFIED Madani Mushaf source, and
   self-host with `pnpm data:mushaf` (download + integrity check + manifest), not
   an arbitrary URL.
2. Keep `core` pure. No database or network imports there. That is what keeps
   it easy to test.
3. The bot uses NO Markdown or HTML parse_mode, ever, for either format: plain
   text messages and plain image captions both. Quran text/characters would make
   a parsed message fail with a 400. See `src/lib/send.ts` (text) and
   `src/lib/send-photo.ts` (image captions). Image is the default format; text
   is the fallback when no image source is set or a page image fails.
4. Advance a position ONLY for a real reason, never on a failed send. The
   trigger differs by kind: a USER advances only when they CONFIRM a read (the
   "read ✓" button or `/next`) — the daily send records the day but does not
   move them, so the wird repeats until read and a missed day never skips
   pages. The CHANNEL advances on the send (a broadcast; the admin sets the
   pace). See "Reading confirmation" below.
5. One wird per subscriber per local day. The `unique(subscriberId,
   scheduledFor)` index on `DeliveryLog` is the lock. Do not work around it.

## How a wird is measured

- A page is one page of the standard Madani Mushaf (604 pages total).
- Each `Ayah` row carries its `page` (1 to 604) and `juz` (1 to 30). Fetching
  one page is a simple query on `page`.
- A wird of N pages starting at page P is pages P, P+1, ... wrapping from 604
  back to 1. See `pagesForWird` and `advanceStartPage` in
  `src/core/wird.ts`.
- Default wird is 1 page a day. The max a user can pick is 20 pages
  (`MAX_WIRD_PAGES`), which is about a juz a day and finishes the Quran in
  about a month. We cap there on purpose: scholars caution against finishing
  the whole Quran in under three days.

## How the daily send works

`deliverDueSubscribers` (in `src/lib/deliver.ts`) runs every
minute. For each active, non-blocked subscriber of an allowed kind:

1. `dueLocalDate` checks their own timezone, send time, and active days.
2. If already delivered for that local date, skip.
3. Take the next N pages from `currentPage` (N is `wirdSize`), wrapping at 604.
4. (USER only) If the wird has gone unread for past days, lead with a gentle
   "you have not read for N days" nudge + an encouragement ayah.
5. Build and send the Arabic message(s), one per page.
6. On success, record the delivery (`commitDelivery`). The CHANNEL passes
   `nextPage` so its `currentPage` advances by N in the same transaction; a
   USER omits `nextPage`, so the row is recorded but the position does NOT move
   (it moves on a confirmed read). The tajweed lesson advances for both (a
   daily drip).
7. (USER only) After the wird, send the "read ✓ / next" button.

One subscriber failing is caught and never stops the rest of the batch.

`/today` and `/page` show today's wird the same way via `buildTodayView` +
`sendTodayView`: the wird is always the LIVE portion at the reader's current
page and size (a view never moves the position), so raising the size or jumping
with `/page` is reflected at once. When today is still free (active day, not
paused, not already delivered) the show RECORDS today's delivery (so the
scheduler skips it) — again without advancing. The same
`unique(subscriber, scheduledFor)` lock keeps it to one wird per local day
across every entry point.

## Reading confirmation, repeat-until-read, and /next

A USER's `currentPage` moves only on a confirmed read, so the wird is never
skipped past:

- Every user wird (the daily send, `/today`, `/page`) is followed by a small
  prompt carrying a **"read ✓ — next"** button (`READ_CONFIRM`,
  `sendConfirmPrompt`), sent SILENTLY (the wird already notified; the prompt is
  its quiet companion, like the recitation — one buzz per day). It is one button
  for the whole wird, however many pages, so a juz-sized day is one tap. The
  channel never gets it.
- Tapping it advances ONE wird and marks the day(s) read (`confirmRead`, an
  atomic compare-and-set on `currentPage`). It is **idempotent**: it works off
  the latest unconfirmed delivery, so a double tap or an old button left in the
  chat from an earlier day is a harmless no-op ("سجّلنا قراءتك ✓"). The tapped
  button is removed on tap. This is the Telegram best practice — edit the
  message in place AND make the action idempotent — so stale buttons cannot
  double-advance.
- If a day goes unconfirmed, the next day's send REPEATS the same wird (the
  position did not move) with the gentle missed-days nudge + an ayah on the
  Qur'an's virtue (`countUnreadDeliveriesBefore`, `pickQuranVirtue`,
  `sendMissedDaysNudge`; the ayah TEXT is read from the verified DB, never
  typed — golden rule #1).
- **`/next`** (`advanceAndShowNext`) confirms the current wird and shows the
  next one now — for a reader who finished early and wants more, or is catching
  up. Each `/next` advances exactly one wird (repeat for several in a sitting).
- The CHANNEL is unchanged: it advances on send and has no button, nudge, or
  `/next`.

The position advance per real send still only counts the pages that actually
went out, so a partial send (an image source dies mid-wird) never records pages
that did not arrive; for a user the whole wird simply repeats next time.

A note on changing the wird size: because a user view never advances, "today's
wird" is always the LIVE portion at the current page and size. So raising the
size with `/wird 20` and re-running `/today` shows the bigger wird at once —
there is no separate "top-up" to do. (Two readers reported the opposite under
the old advance-on-send model, where an early `/today` had frozen the day at the
old size; the read-gated model fixes that for free.)

## Daily tajweed lesson

Right BEFORE the wird, the bot can post a short tajweed micro-lesson. It is OFF
by default (the `tajweedEnabled` column defaults to false), so the wird stays the
focus and the lesson is a deliberate opt-in: a user turns it on with `/tajweed`
(or `/tajweed on`), the channel admin with `/admin_tajweed on`. (The existing
channel row, created before this default flipped, keeps whatever it was set to;
only NEW subscribers default off.) The deck is authored reference data in
`src/database/reference/tajweed-lessons.ts`, ordered, drawn from تحفة الأطفال and
المقدمة الجزرية. It is NOT Quran text: each lesson only NAMES an example by
`(surah, ayah)`, and the verified Uthmani text is read from the database
(`getAyahText`) at send time — the golden rule applies to the deck too (a test
fails if a body/note contains `﴿ ﴾`). The deck has been reviewed and is LIVE
(`LESSONS_PENDING_REVIEW = false`). The flag is a kept safety gate, not dead
code: set it back to `true` (e.g. while editing the deck or adding lessons that
need a fresh review) and `tajweedLessonView` short-circuits so the lesson is
NEVER sent, `/tajweed` replies "coming soon", and startup warns — independent of
the per-reader toggle. Flip it back to false once a qualified reader has gone
through the new material.

Each subscriber has `tajweedEnabled` (off by default) and `tajweedLessonIndex`.
A subscriber who turns the lesson on starts at `tajweedLessonIndex = 0`, the first lesson of the deck (the
deck is authored in teaching order: intro, then makharij, sifat, ahkam an-nun,
ahkam al-mim, the mudud, and waqf). The lesson is best-effort and NEVER blocks
the wird; the wird send stays the source of truth for blocked/failed. The lesson
index advances by one (wrapping to 0 — the deck repeats, like the wird loops the
Mushaf) ONLY when the lesson actually went out AND the day is committed, in the
same `commitDelivery` transaction. So each reader walks the deck in order from
lesson 1, one a day. Lesson text is sent first, then (best effort) its example
audio clip: an optional self-hosted per-ayah recitation (`TAJWEED_AUDIO_BASE_URL`,
fetched with `pnpm data:tajweed`, Husary by default), cached by Telegram file_id
(`TajweedAudio`) exactly like the Mushaf images. Without an audio source, lessons
go out as text + the example.

### Browsing all lessons (the lessons library)

The daily lesson is a slow drip (one a day, in order). A reader who wants a
specific rule now can open the whole deck: the `/tajweed` message carries a
"📚 كل دروس التجويد" button that opens a paginated index of every lesson, and
tapping one shows it in place with a "back to the list" button (the back button
returns to the page the lesson was on, derived from its index). This is a
READ-ONLY library: it never reads or moves `tajweedLessonIndex`, and it works
whether or not the daily lesson is toggled on. It is gated by
`LESSONS_PENDING_REVIEW` like the daily lesson (every browser handler re-checks
the flag, since callback data is client-supplied). The index keyboard and its
pagination live in `src/lib/tajweed-lessons-keyboard.ts` (the ayah surah-picker
shape: one button per item, a prev/indicator/next nav row); a browsed lesson is
rendered by `renderLessonAt(index)` in deliver.ts, which reuses `formatLesson`
with a "الدرس N من M" header (not "today's") so it does not read as the daily
lesson. The browser is text-only (no audio): Telegram cannot put a clip in an
edited message, and piling up audio while paging would be noise — the daily
delivery is where the example clip is heard.

## Daily page recitation

After the wird, the bot sends an audio recitation of each delivered page (on by
default for users and the channel; `/reciter` switches voice or turns it off,
`/admin_reciter <off|key>` for the channel). Each subscriber has `reciter`
(default `abdulbasit`) and `wirdAudioEnabled`. The reciters and the per-page URL
builder live in `src/core/reciter.ts` (`RECITERS` maps each key to its
everyayah.com data folder; `pageAudioSource(reciter, page)` builds
`…/PageMp3s/Page<NNN>.mp3`). The clip is fetched from everyayah (trusted,
no-copyright) the first time and then re-sent by cached `file_id` (`PageAudio`,
keyed by page+reciter) — same approach as the Mushaf images, so the full set is
never stored locally. Sending is best-effort and page-by-page (`sendPageAudio`
in deliver.ts): a failed clip is skipped and NEVER blocks the wird; it runs
after the delivery is recorded, for exactly the pages that went out. A juz wird
therefore sends one audio per page.

The recitation is **silent** (`disable_notification`), a quiet companion to the
wird that just notified, so a multi-page wird does not buzz once per page. This
matches the ayah bot, whose audio is silent for the same reason. The tajweed
example clip is silent too (the lesson text is the notification). The `silent`
flag lives on `sendAudio` (`src/lib/send-audio.ts`).

The recitation follows the wird on EVERY entry point, not just the scheduler:
the daily send (`deliverDueSubscribers`), `/today`, and the `/page` reposition
all call `sendPageAudio` the same way (the last two through `sendTodayView` in
bot.ts), so the audio always matches the wird the reader just got. It is tied to
a REAL delivery on all of them: the scheduler and `sendTodayView` both gate the
audio on a fresh `commitDelivery` of 'sent', so a `/today` re-show (no new
record) or the loser of a race with the scheduler shows the wird again but does
NOT re-send the audio. `/next` sends the next wird's recitation through
`sendWirdNow`. The recitation reads the subscriber's CURRENT settings each time,
so a setting change is honoured on the very next send with no extra wiring:

- Raise the wird size with `/wird N`: the next wird (or the live `/today`) is N
  pages, and the recitation is the same N pages, one clip each (the loop in
  `sendPageAudio` walks every delivered page).
- Jump with `/page N` (or `/admin_setpage` on the channel): the recitation is
  for the new page(s), because it sends exactly `content.slice(0, pagesSent)`
  from the new position, never a stale page.
- Switch voice with `/reciter <key>`: the clip uses the new reciter's URL, and
  the `file_id` cache is keyed by `(page, reciter)`, so a changed voice is a
  cache MISS and fetches the new reciter (it never serves the old voice's
  cached clip). Picking a reciter also turns the audio back on (`setReciter`
  sets `wirdAudioEnabled = true`), so a reader who did `/reciter off` and later
  picks a voice starts hearing it again.

To let a reader hear a new voice at once, the reciter confirmation (the picker
pick and `/reciter <key>`) carries a "جرّب على صفحة اليوم" preview button,
mirroring the ayah bot. Tapping it plays ONE page's recitation in the new voice
— today's DELIVERED page if there is one, else the current page (`sampleAudioPagesFor`
resolves it, `sendPageAudio` sends it) — never the whole multi-page wird. It is
a SILENT peek: it records no delivery and never advances the position, so it can
be tapped freely and never collides with the daily send.

## Page tafseer (/tafsir)

A page holds many ayat, so we never send tafseer TEXT here. Instead `/tafsir`
replies a link (one URL button per page of the reader's wird) to that Mushaf
page on quran.com (`pageTafseerUrl` -> `quran.com/ar/page/N`), where every
ayah's tafsir (Al-Muyassar, As-Saadi, Ibn Kathir, and more) is one tap away.
quran.com is the Quran.Foundation site, the same trusted source the ayah bot
links its tafseer to.

It is on-demand and link-only: no stored text, no schema, no per-delivery
clutter, so there is nothing to enable or disable (running the command is the
opt-in). The pages follow the reader's CURRENT wird — `wirdPageNumbersFor`
returns today's DELIVERED pages if today is delivered, else the current
position for the current wird size, through `getWird` so the page numbers are
real (clamped at the end of the Mushaf). So the links stay correct after
`/wird N` (size change) or `/page N` (position change). The keyboard
(`src/lib/tafseer-keyboard.ts`) lays the pages out a few per row so even a
full-juz (20-page) wird stays compact.

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
- Arabic text lives in `src/lib/copy.ts`. It is right to left;
  wrap any left to right run (a command, a time, a timezone) with the `ltr()`
  helper so the punctuation around it does not reorder.

## Common commands

```bash
pnpm install
pnpm data:fetch     # download + verify the Quran text, pages, and juz (once; also committed)
pnpm data:mushaf    # (optional) download + verify the 604 page images to self-host them
pnpm data:tajweed   # (optional) download + verify the tajweed example clips to self-host them
pnpm db:deploy      # apply migrations (create tables)
pnpm db:seed        # fill the Quran tables
pnpm dev            # run the bot with reload
pnpm test           # all tests
pnpm check          # typecheck + lint + test (run before pushing)
pnpm db:studio      # browse the database
```

### Changing the schema

Edit `prisma/schema.prisma`, then make a migration:

```bash
pnpm db:migrate     # prisma migrate dev: creates a new migration and applies it
```

Commit the new folder under `prisma/migrations/`. Production applies it with
`pnpm db:deploy`.

## Gotchas

- There is ONE `.env`, at the repo root. Code and scripts load it through
  `loadEnv()` in `src/core/env.ts`, which finds the root (the folder with
  `package.json`) no matter where the command runs. `prisma.config.ts` has the
  same loader inline.
- `NODE_ENV` defaults to `production`. `pnpm dev` sets `NODE_ENV=development`
  itself, so local work always runs in development mode no matter what `.env`
  says.
- Prisma 7 does not read `.env` on its own and does not take the URL in the
  schema. The CLI gets the URL from `prisma.config.ts`; the running bot builds
  its own client in `src/database/client.ts`.
- The generated Prisma client lives in `src/database/generated`. It
  is git ignored. Run `pnpm db:generate` if imports from it fail.
- `activeDays` is a 7-bit mask (bit 0 = Monday). Use the helpers in
  `src/core/days.ts`, do not do bit math by hand elsewhere. The day
  picker shows days Saturday first (the order Arabic readers expect), but the
  stored mask is still ISO (Monday = 1). Only the display order differs; see
  `WEEKDAY_DISPLAY_ORDER` in copy.ts.
- Timezone and page math always take `now` (or the inputs) as arguments so they
  can be tested. Do not call `new Date()` deep inside pure functions.
- The channel chat id can be a numeric id or a public @username in `.env`. It
  is resolved to a numeric id once at startup and stored on the channel
  subscriber row.

## Where things live

- Shared kernel (schedule, days, arabic, env, logger, send): the
  `telegram-bot-kit` package; the matching `src/core/*` and `src/lib/{send,logger}.ts`
  files are re-export shims.
- Page and wird math: `src/core/wird.ts`
- Message building (one message per page): `src/core/format.ts`
- Page recitation: reciters + per-page URL builder in `src/core/reciter.ts`;
  the file_id cache in `src/database/services/page-audio.service.ts` (table
  `page_audio`); the delivery (`sendPageAudio`) and reciter names/captions in
  `src/lib/deliver.ts` and `src/lib/copy.ts`; the picker in
  `src/lib/reciter-keyboard.ts`. The "try it on today's page" preview button is
  `sampleAudioPagesFor` in deliver.ts + the `RECITER_SAMPLE` handler in bot.ts.
- Page tafseer link (`/tafsir`): the URL builder `pageTafseerUrl` in
  `src/core/tafseer.ts`, the page resolver `wirdPageNumbersFor` in deliver.ts,
  the keyboard in `src/lib/tafseer-keyboard.ts`, the command in bot.ts.
- Tajweed lesson math + formatter: `src/core/tajweed.ts`; the lesson deck:
  `src/database/reference/tajweed-lessons.ts`; the example-audio sender +
  file_id cache: `src/lib/send-audio.ts` + `src/database/services/tajweed-audio.service.ts`;
  the delivery wiring (`tajweedLessonView`, `sendLesson`): `src/lib/deliver.ts`;
  the self-host script: `scripts/fetch-tajweed-audio.ts`.
- Tajweed lessons browser (the full library): the paginated index keyboard +
  page math in `src/lib/tajweed-lessons-keyboard.ts`; the per-lesson renderer
  `renderLessonAt` in `src/lib/deliver.ts`; the open button on the `/tajweed`
  keyboard in `src/lib/tajweed-keyboard.ts`; the callback handlers in `bot.ts`.
- Surah names and revelation: `src/database/reference/surahs.ts`
- Ayah count oracle: `src/database/reference/ayah-counts.ts`
- Page and juz constants and anchors: `src/database/reference/pages.ts`
- Message wording (Arabic): `src/lib/copy.ts`
- The send engine: `src/lib/deliver.ts` (`sendWird`, called by both `/today` and
  the scheduler). Text goes one message per page, in order. Images go as albums
  of up to 10 pages per `sendMediaGroup` (one ordered, single-notification post,
  caption on the first item only, since each Mushaf image shows its own page
  number); a 1-page wird is a plain photo. If an album fails it falls back to
  per-page, and a failed photo falls back to text, so a bad page never costs the
  rest of the wird. The position advances by exactly the pages actually sent.
- Today's wird (read-gated): `buildTodayView` (returns the live wird + a
  `record` that does NOT advance) and `sendTodayView` (the shared renderer for
  `/today` and `/page`) in `src/lib/deliver.ts` / `bot.ts`; `commitDelivery`
  (records; advances only when given `nextPage`, i.e. the channel) in
  `src/database/services/delivery.service.ts`.
- Reading confirmation + repeat + /next: the `READ_CONFIRM` button + the
  `sendConfirmPrompt` / `sendMissedDaysNudge` / `sendWirdNow` helpers in
  `src/lib/deliver.ts`; the `handleReadConfirm` and `advanceAndShowNext`
  handlers in `bot.ts`; `confirmRead` (compare-and-set advance),
  `getLatestUnconfirmedDelivery`, and `countUnreadDeliveriesBefore` in
  `delivery.service.ts`; the encouragement deck in
  `src/database/reference/quran-virtues.ts` (`pickQuranVirtue`).
- Delivery format (Mushaf-page image vs text): `src/core/mushaf-image.ts` (the
  format flag and the page-image source builder), `src/lib/send-photo.ts` (the
  photo + album senders), the `wirdFormat` column and the `mushaf_page_images`
  file_id cache. Image is the DEFAULT format (the `wirdFormat` column defaults to
  "image"); a user switches with `/format`, the channel admin with
  `/admin_format`. Image needs `MUSHAF_IMAGE_BASE_URL` set (an http URL or a
  local path the bot uploads); without a source the bot falls back to text at
  send time. Like the text, image pages must come from a verified Madani Mushaf
  source.
