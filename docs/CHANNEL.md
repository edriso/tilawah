# Channel setup

Tilawah can run a public Telegram channel that posts one page of the Quran a
day to everyone who follows it. This page has ready-to-paste Arabic text for
the channel name, its description, and a pinned welcome post, plus how an admin
controls it. The channel is optional; set `CHANNEL_CHAT_ID` to turn it on (see
`docs/DEPLOY.md`).

The user-facing text is Arabic. Copy each block as is; it already points to the
bot at `@TilawahDailyBot`.

---

## How the channel works

- It posts one Mushaf page per day by default, in order: page 1, then 2, then
  3, all the way to page 604, then it starts again at page 1. So it moves
  forward through the whole Quran and loops forever.
- Each day's post is the page itself (a picture of the Mushaf page) and an
  audio recitation of that page (Abdul Basit by default). An optional short
  tajweed lesson (one rule a day) can lead the post; it is OFF by default, so
  an admin turns it on with `/admin_tajweed on`. An admin can also turn the
  recitation off or change the reciter (see below).
- The page count per day, the post time, the days, and the timezone are all
  set by an admin (see the commands below). Nothing is posted while the
  channel is paused.
- The text is the verified Tanzil Uthmani edition, numbered by the standard
  Madani Mushaf of 604 pages. It is never edited by the bot. The recitation
  audio comes from a trusted source (everyayah.com) and is fetched once per
  page then re-sent from a cache.

---

## Channel name

(Telegram: channel Info, Edit, Channel name.)

تلاوة — وردك اليومي من القرآن

## Channel description

(Telegram: channel Info, Edit, Description. Up to about 255 characters.)

صفحة من القرآن الكريم كل يوم بإذن الله 🌿 مع تلاوتها صوتيًا، بترتيب المصحف المدني من أوله إلى آخره ثم نبدأ من جديد. ولوردٍ خاص بك (صفحة أو أكثر، بالوقت والقارئ الذي تختار) ابدأ مع البوت: @TilawahDailyBot

---

## Pinned welcome post

(Post this in the channel once, then pin it: tap the message, Pin. Two bullets
are conditional: the tajweed-lesson line assumes you enable it with
`/admin_tajweed on` — it is OFF by default, so drop that bullet if you won't
enable it; and the "صورة الصفحة" line assumes the image format is configured
(`MUSHAF_IMAGE_BASE_URL`), otherwise the channel posts the page as text.)

السلام عليكم ورحمة الله وبركاته 🌿

مرحبًا بكم في قناة "تلاوة". تنشر القناة كل يوم بإذن الله صفحة واحدة من القرآن الكريم، فاجعلوها وردكم اليومي.

• صفحة واحدة كل يوم، في وقت ثابت.
• بترتيب المصحف: من سورة الفاتحة إلى سورة الناس، فإذا تمّ ختم القرآن بدأنا من جديد.
• تُنشر صورة الصفحة من المصحف المدني الشريف (٦٠٤ صفحات)، ومعها تلاوتها صوتيًا بصوت الشيخ عبد الباسط عبد الصمد.
• ودرس تجويد قصير قبل الصفحة، يعينكم على تصحيح التلاوة.

هل تريد وردًا خاصًا بك؟ يمكنك أن تأخذ صفحة أو أكثر في اليوم (حتى جزء كامل)، وتختار وقت الإرسال والأيام والقارئ الذي يناسبك، وتأخذ راحة وتعود من حيث توقفت.
ابدأ الآن مع البوت: @TilawahDailyBot

نسأل الله أن يرزقنا تلاوته آناء الليل وأطراف النهار، وأن يجعله حُجَّة لنا لا علينا.

---

## Admin control

These commands work only for the Telegram ids in `ADMIN_TELEGRAM_IDS`, and only
in a private chat with the bot. They act on the channel.

- `/admin_setpage N` set the last page that was already read (1 to 604). The
  next post starts at page N+1, wrapping from 604 back to 1. Use this to align
  the channel with where your readers are, or to skip ahead or back.
- `/admin_restart` begin a fresh khatma now: the channel goes back to page 1 and
  the first tajweed lesson. The page wraps past 604 to 1 on its own, so you only
  need this to start over early (e.g. at the start of a new month).
- `/admin_wird N` set how many pages the channel posts per day (1 to 20).
- `/admin_format text|image` how the channel posts the wird: a picture of the
  Mushaf page (the default) or plain text. Image needs `MUSHAF_IMAGE_BASE_URL`
  set (see `docs/DEPLOY.md`); without it the channel quietly posts text.
- `/admin_reciter <off|key>` set the voice for the page recitation, or turn it
  off. Keys: `abdulbasit` (default), `husary`, `alafasy`, `sudais`, `minshawi`,
  `ayyoub`, `ali-jaber`, `aziz-alili`, `al-banna`.
- `/admin_tajweed on|off` turn the short tajweed lesson (posted before the page)
  on or off for the channel.
- `/admin_review` send yourself the whole tajweed lesson deck as one document,
  to read or forward to a scholar for review. (It works whether the lessons are
  live or not.)
- `/admin_time HH:MM` set the daily post time (24-hour, in the channel's
  timezone).
- `/admin_tz Area/City` set the channel's timezone, e.g. `Africa/Cairo`.
- `/admin_pause` pause the channel, or resume it if already paused. While
  paused nothing is posted and the page does not move.
- `/admin_status` show the channel's current settings and page position.
- `/admin_stats` subscriber counts: how many users (active, paused, blocked),
  the channel, and the breakdown by riwayah, format, audio, and tajweed.
- `/admin_send` send the due batch right now (handy for a smoke test).
- `/admin_preview N [pages]` render exactly what the bot would send for page
  `N` (or a run of `pages`, default 1), into your private chat, without
  changing the channel position or posting to the channel. A manual test for
  any page. Example: `/admin_preview 10 2` shows pages 10 and 11.
- `/admin_health` the bot's uptime.
- `/admin_help` list every admin command (they are not in the public command
  menu, so this is your reference).

Every admin command validates its input and changes nothing on bad input, with
a clear Arabic reply. A non-admin who tries one is politely refused.

---

## Setup checklist

1. Create the channel and set its name and description (above).
2. Add the bot to the channel as an administrator that can post messages.
3. Get the channel chat id (forward a channel post to @userinfobot, or use a
   public @username) and set `CHANNEL_CHAT_ID` in `.env`.
4. Put your own Telegram id in `ADMIN_TELEGRAM_IDS` (message @userinfobot to
   get it).
5. Start the bot. In a private chat with it, send `/admin_setpage N` with the
   last page already read so the channel continues from page N+1, and set the
   time and days you want.
6. Post the welcome message above in the channel and pin it.
