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

## Health check

Point your host's health check at `GET /health` on the port from `PORT`
(default 8080). It returns 200 with a small JSON body while the bot is alive.

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
