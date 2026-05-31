# Channel setup

Tilawah can run a public Telegram channel that posts one page of the Quran a
day to everyone who follows it. This page has ready-to-paste Arabic text for
the channel name, its description, and a pinned welcome post, plus how an admin
controls it. The channel is optional; set `CHANNEL_CHAT_ID` to turn it on (see
`docs/DEPLOY.md`).

The user-facing text is Arabic. Copy each block as is, then replace
`@YourBotUsername` with your bot's real username.

---

## How the channel works

- It posts one Mushaf page per day by default, in order: page 1, then 2, then
  3, all the way to page 604, then it starts again at page 1. So it moves
  forward through the whole Quran and loops forever.
- The page count per day, the post time, the days, and the timezone are all
  set by an admin (see the commands below). Nothing is posted while the
  channel is paused.
- The text is the verified Tanzil Uthmani edition, numbered by the standard
  Madani Mushaf of 604 pages. It is never edited by the bot.

---

## Channel name

(Telegram: channel Info, Edit, Channel name.)

تلاوة — وردك اليومي من القرآن

## Channel description

(Telegram: channel Info, Edit, Description. Up to about 255 characters.)

صفحة واحدة من القرآن الكريم كل يوم بإذن الله 🌿 بترتيب المصحف المدني، من أول القرآن إلى آخره ثم نبدأ من جديد. وللحصول على وردٍ خاص بك (صفحة أو أكثر، في الوقت والأيام التي تختارها) ابدأ مع البوت: @YourBotUsername

---

## Pinned welcome post

(Post this in the channel once, then pin it: tap the message, Pin.)

السلام عليكم ورحمة الله وبركاته 🌿

مرحبًا بكم في قناة "تلاوة". تنشر القناة كل يوم بإذن الله صفحة واحدة من القرآن الكريم، فاجعلوها وردكم اليومي.

• صفحة واحدة كل يوم، في وقت ثابت.
• بترتيب المصحف: من سورة الفاتحة إلى سورة الناس، فإذا تمّ ختم القرآن بدأنا من جديد.
• النص هو النص العثماني المدقّق من مشروع تنزيل، بترقيم صفحات المصحف المدني (٦٠٤ صفحات).

هل تريد وردًا خاصًا بك؟ يمكنك أن تأخذ صفحة أو أكثر في اليوم (حتى جزء كامل)، وتختار وقت الإرسال والأيام التي تناسبك، وتأخذ راحة وتعود من حيث توقفت.
ابدأ الآن مع البوت: @YourBotUsername

نسأل الله أن يرزقنا تلاوته آناء الليل وأطراف النهار، وأن يجعله حجّةً لنا لا علينا.

---

## Admin control

These commands work only for the Telegram ids in `ADMIN_TELEGRAM_IDS`, and only
in a private chat with the bot. They act on the channel.

- `/admin_setpage N` set the last page that was already read (1 to 604). The
  next post starts at page N+1, wrapping from 604 back to 1. Use this to align
  the channel with where your readers are, or to skip ahead or back.
- `/admin_wird N` set how many pages the channel posts per day (1 to 20).
- `/admin_time HH:MM` set the daily post time (24-hour, in the channel's
  timezone).
- `/admin_tz Area/City` set the channel's timezone, e.g. `Africa/Cairo`.
- `/admin_pause` pause the channel, or resume it if already paused. While
  paused nothing is posted and the page does not move.
- `/admin_status` show the channel's current settings and page position.
- `/admin_send` send the due batch right now (handy for a smoke test).

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
