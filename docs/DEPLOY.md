# Deploy

Tilawah is a single long running Node process plus a MySQL/MariaDB database. It
uses Telegram long polling, so it does not need a public URL. There is a small
`/health` endpoint for uptime checks.

## What you need

- A MySQL or MariaDB database.
- A Telegram bot token from @BotFather.
- A host that runs a Node 20+ process and restarts it on crash (Fly.io, a
  small VPS with systemd or pm2, a container platform, etc.).
- For the channel: a Telegram channel with the bot added as an admin that can
  post, and the channel chat id.

## First deploy

```bash
pnpm install --prod=false
pnpm data:fetch          # writes the frozen Quran data file (skip if cloned, it is committed)
pnpm db:deploy           # applies the migrations (creates the tables)
pnpm db:seed             # fills the Quran tables (surahs and ayat with page/juz)
pnpm start               # runs the bot (src/index.ts)
```

`db:deploy` and `db:seed` are setup steps. Run them once per environment when
you first deploy, and `db:deploy` again after a new migration. The bot refuses
to start until the Quran data is fully seeded, so you cannot forget.

Set these env vars on the host (see the single root `.env.example`):

- `BOT_TOKEN`            from @BotFather (required)
- `DATABASE_URL`         the MySQL connection string (required)
- `CHANNEL_CHAT_ID`      the channel to post to (numeric id or @username); empty for no channel
- `ADMIN_TELEGRAM_IDS`   comma separated admin ids who control the channel
- `USER_WIRD_ENABLED`    "true" (default) to serve users, "false" for channel only
- `TZ_NAME`              default timezone for new subscribers and the channel
- `NODE_ENV`             defaults to "production"
- `PORT`                 health endpoint port, defaults to 8080
- `TAJWEED_AUDIO_BASE_URL` audio for the daily tajweed lesson's example ayah;
  defaults to the clips baked into the image (`/app/assets/tajweed/...`)

The daily **page recitation** (the reciter audio after each wird) needs no
config: clips are fetched from everyayah.com and then re-sent from a cache. The
**tajweed lesson** example clips (`assets/tajweed/*.mp3`, ~8 MB, 34 clips) are
committed and baked into the image, so the `TAJWEED_AUDIO_BASE_URL` default above
works out of the box. They are small and are freely shareable Quran recitation,
so unlike the page images they stay in the repo. They are still regenerable with
`pnpm data:tajweed` (and `pnpm data:tajweed --check` to re-verify on disk), so a
lost or updated clip is one command away.

## Three ways to run it

- Channel and users: set `CHANNEL_CHAT_ID` and keep `USER_WIRD_ENABLED=true`.
- Channel only: set `CHANNEL_CHAT_ID` and `USER_WIRD_ENABLED=false`.
- Users only: leave `CHANNEL_CHAT_ID` empty.

## Setting up the channel

1. Create a Telegram channel and add the bot as an admin that can post.
2. Get the channel chat id (forward a channel post to @userinfobot, or use a
   public @username) and put it in `CHANNEL_CHAT_ID`.
3. Put your own Telegram id in `ADMIN_TELEGRAM_IDS` (message @userinfobot to
   get it).
4. Start the bot. In a private chat with the bot, send `/admin_setpage N` with
   the last page that was already read; the channel will post page N+1 next.

See `docs/CHANNEL.md` for the full admin command list and the paste-ready
channel name, description, and pinned welcome post.

## Image delivery format (the default)

By default the wird is sent as a picture of the actual Madani Mushaf page. A
user can switch to plain text (searchable and copyable) with `/format`, and the
channel admin with `/admin_format text`. Images need a page-image source; until
you set one, the bot quietly falls back to sending text to everyone:

1. Host (or point at) a VERIFIED Madani Mushaf, 604 pages, the standard 15-line
   King Fahd Complex layout. Like the text, the images are the holy Quran, so
   they must come from a trusted source.
2. Set `MUSHAF_IMAGE_BASE_URL` to the page URL template, using `{page}` for the
   raw number or `{page3}` for it zero-padded to three digits, e.g.
   `https://your-host.example/mushaf/{page3}.png`.
3. Test it before turning it on for readers:

   ```bash
   pnpm test:image <yourTelegramId> 50   # sends Mushaf page 50 to you
   ```

   It prints the `file_id` Telegram returns. The bot caches that id per page
   (table `mushaf_page_images`), so each page is fetched from the source once
   and re-sent by reference after that. If the source is ever unreachable and a
   page is not yet cached, the bot falls back to sending that page as text, so
   the wird always goes out.

If you leave `MUSHAF_IMAGE_BASE_URL` empty, the bot runs text-only: everyone
quietly receives text (the default image format has nowhere to fetch pages
from), and `/format` offers text only.

### Self-hosting the page images (recommended for trust)

Pointing `MUSHAF_IMAGE_BASE_URL` at a stranger's host means you depend on it
staying up and unchanged. To own a verified copy instead:

```bash
pnpm data:mushaf            # download all 604 pages + write a SHA-256 manifest
pnpm data:mushaf --check    # re-verify the on-disk set against the manifest (offline)
```

This writes the pages to `assets/mushaf/` and a `manifest.json` of fingerprints.
The images are git-ignored (too large to commit), but the manifest IS tracked,
so `--check` later flags ANY upstream change (a swapped or tampered page).
Override the source or destination with flags, e.g.
`pnpm data:mushaf --source "https://.../{page}.jpg" --out assets/mushaf`.

The manifest pins the bytes you reviewed; it does not prove the pages are
correct, so eyeball a few the first time. (After changing the source, clear the
cache so new images are fetched: `TRUNCATE TABLE mushaf_page_images;`.)

Three ways to serve the verified set:

The images live in the server's shared data tree, OUTSIDE this code checkout, at
`/opt/bots/data/tilawah/mushaf`. Keeping them out of `/opt/bots/telegram/tilawah`
means a `git pull` or `reset` during deploy can never touch them. (This matches
the server convention for big runtime files; see the hetzner-cloud-server guide,
chapter 4, "Big files a bot needs".)

**A. Download on your laptop, upload to the server (recommended).** You review
the images locally, then ship the exact bytes; the server never fetches from
anyone. The bot uploads each page from disk itself (no public URL needed, which
suits this long-polling bot). On your laptop you already ran `pnpm data:mushaf`
and checked it; now copy the folder up. Because the target is a plain data
folder (not a git checkout), you can upload everything, manifest included, and
the order does not matter. `--mkpath` creates the destination folder:

```bash
# on your laptop
rsync -av --mkpath \
  assets/mushaf/ root@<server>:/opt/bots/data/tilawah/mushaf/
```

In `/opt/bots/docker-compose.yml`, give the `tilawah` service the read-only
bind mount shown in `compose.example.yml`:

```yaml
    volumes:
      - ./data/tilawah/mushaf:/app/assets/mushaf:ro
```

Set `MUSHAF_IMAGE_BASE_URL="/app/assets/mushaf/{page3}.jpg"` (a path, not a URL)
in the bot's `.env`, then `docker compose up -d tilawah`. The folder is outside
git, so **deploys never touch it**, and the `file_id` cache (in the database)
means each page uploads to Telegram only once, so **deploys never re-upload**
either. Refresh later by re-running `rsync`. Confirm the container sees the
pages: `docker compose exec tilawah ls assets/mushaf | head` (an EMPTY result
means the source folder was empty when you started the bot: fill it, then re-up).

**B. Let the server download instead.** If you would rather not upload ~90 MB,
download straight into the data folder on the server with a throwaway container,
then bind-mount it the same as A:

```bash
mkdir -p /opt/bots/data/tilawah/mushaf
cd /opt/bots
docker compose run --rm -v /opt/bots/data/tilawah/mushaf:/out \
  tilawah sh -c "pnpm data:mushaf --out /out"
```

The server downloads from the source, not your laptop, but the result is the
same folder the `:ro` bind mount serves. Verify it before going live (next
point): run `pnpm data:mushaf --check --out /out` and eyeball a few pages.

**C. Your own static host (URL).** If you already serve static files (a Netlify
site, a Caddy `file_server`), upload `assets/mushaf/` there and set
`MUSHAF_IMAGE_BASE_URL="https://your-host/mushaf/{page3}.jpg"`. No bot change.

**Page recitation audio (the same shape).** The per-page recitation is a second
self-hosted asset built exactly like the images: make the verified set, keep it
in the shared data tree, and bind-mount it read-only. Its full runbook (build,
verify, the `volumes` line, the `PAGE_AUDIO_BASE_URL` env, and the `page_audio`
cache clear) is in `DEVELOPMENT.md`, section "Building the page recitation
audio"; the volume is also shown in `compose.example.yml`. Until you build a
given reciter's set, the bot streams that reciter from everyayah, so you can roll
it out one reciter at a time.

## Verify the Quran assets before you go live (required)

This bot sends the holy Quran: page images and recitation audio. A wrong or
tampered file is far worse than a code bug, and the bot cannot tell good content
from bad, it just sends what it is given. So treat verification as a required
gate, not an optional nicety. Both asset sets are regenerable by command, which
also lets you re-verify them offline at any time:

1. **Page images** (`pnpm data:mushaf`). Download from a TRUSTED source only (the
   default is the colored Tajweed Hafs Madani set, 604 pages, standard 15-line
   King Fahd layout). Then:
   - `pnpm data:mushaf --check` re-checks every page against the tracked
     `manifest.json` (SHA-256), flagging any swapped or tampered file.
   - The manifest pins the bytes you reviewed; it does not prove they are
     correct, so **open and eyeball several pages by eye** the first time.
   - `pnpm test:image <yourTelegramId> 50` sends a real page to you in Telegram,
     so you see exactly what a reader would get.
2. **Tajweed lesson clips** (`pnpm data:tajweed`). `pnpm data:tajweed --check`
   re-verifies the on-disk clips; **listen to a couple** to confirm the right
   ayah and clean audio.
3. **Page recitation audio** (`pnpm data:page-audio`, if you self-host it). Build
   the per-page clips from the trusted per-ayah recitations, then
   `pnpm verify:audio --dir assets/page-audio` (add `--deep --full` to prove each
   page covers the right ayat, not everyayah's defective split); **listen to a
   couple**. After mounting a new set on the server, clear the `page_audio`
   file_id cache so the new clips are sent, not the old cached ones.
4. **Dry run to yourself first.** Point `CHANNEL_CHAT_ID` at a PRIVATE test
   channel (or just use a DM with `USER_WIRD_ENABLED=true`) and watch a full
   wird go out, with the image and the tajweed clip, before you ever point the
   bot at the public channel.

Only after these pass should you set the live `CHANNEL_CHAT_ID` and start posting
to real readers.

## Running with Docker

The repo ships a `Dockerfile` (runs from TypeScript with tsx, no compile step)
and a `docs/compose.example.yml` fragment. The server uses one shared Compose
project (at `/opt/bots`) that runs several bots against a shared MariaDB; copy
the two services from `compose.example.yml` (`tilawah` and the one-off
`tilawah-migrate`) into that shared file. Secrets come from an env file on the
server (`/opt/bots/telegram/tilawah/.env`), never committed.

Pushes are gated: the `deploy` workflow runs `pnpm check` (typecheck + lint +
tests) first and only deploys if it passes, so a broken build never reaches
production.

## Health check

Point your host's health check at `GET /health` on the port from `PORT`
(default 8080). It returns 200 with a small JSON body while the bot is alive.
The Docker image also defines a `HEALTHCHECK` against the same endpoint, so
`docker ps` and the orchestrator can tell a wedged bot from a healthy one.

## Restarts are safe

On start the bot runs a catch up delivery, so if it was down at a send time,
today's wird still goes out once. The per day idempotency record makes sure a
restart never double sends.

## Updating the bot

```bash
git pull
pnpm install
pnpm db:deploy     # apply any new migrations
pnpm start
```

You do not need to re-run `data:fetch` or `db:seed` on a normal update. The
Quran data does not change.
