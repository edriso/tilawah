# BotFather setup

Ready to paste text for setting up the bot in @BotFather (the `/mybots` then
Edit Bot menu). The bot UI is Arabic, so the public texts are Arabic too. Copy
each block as is.

Note: the bot sets its own command list on every start (via `setMyCommands` in
`apps/telegram/src/bot.ts`), and it lists the personal commands only when
`USER_WIRD_ENABLED` is true. You only need to paste commands into BotFather if
you also want them set by hand. The admin commands are never listed publicly.

---

## Name

تلاوة

## About

(BotFather "Edit About", about 120 characters.)

وردك اليومي من القرآن 🌿 صفحة كل يوم، أو أكثر حتى جزء كامل، في الوقت والأيام التي تختارها. اضغط Start للبدء.

## Description

(BotFather "Edit Description", up to about 512 characters.)

السلام عليكم ورحمة الله 🌿
بوت "تلاوة" يعينك على قراءة وردك اليومي من القرآن الكريم:
• يصلك كل يوم وردك من المصحف، صفحة واحدة افتراضيًا، ويمكنك زيادتها حتى ٢٠ صفحة.
• تختار وقت الإرسال والأيام التي تناسبك.
• يمكنك أخذ راحة وقتما تشاء، وتعود من حيث توقفت.
اضغط Start للبدء بإذن الله.

---

## Commands

When BotFather says "Send me a list of commands", paste this block (no leading
slashes, one command per line, `command - description`). These are the personal
user commands; do not list the admin commands.

today - قراءة ورد اليوم
wird - حجم الورد اليومي
time - ضبط وقت الإرسال
days - اختيار أيام الإرسال
timezone - ضبط المنطقة الزمنية
pause - أخذ راحة أو العودة منها
status - عرض إعداداتك
help - المساعدة

---

## Other settings

- Group privacy: this is a one to one bot for users and a poster for the
  channel, so you can leave group privacy ON (the default).
- For the channel: add the bot to your channel as an admin that can post
  messages, then set `CHANNEL_CHAT_ID` and `ADMIN_TELEGRAM_IDS` in `.env`.
- Privacy Policy: optional. The bot stores only what it needs to deliver the
  wird (the chat id, timezone, send time, days, wird size, current page, and a
  per day delivery record).
