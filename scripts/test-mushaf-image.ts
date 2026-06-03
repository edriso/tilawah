// Manual visual test for the "image" delivery format. It sends ONE Madani
// Mushaf page to a chat as a photo, exactly the way the bot will, and prints
// the file_id Telegram returns (the value the bot caches in mushaf_page_images
// so later sends are a cheap reference). Use it to eyeball that your
// MUSHAF_IMAGE_BASE_URL points at correct, legible Mushaf pages BEFORE turning
// the format on for real readers.
//
// It does NOT touch the database. It only needs BOT_TOKEN and a reachable
// image URL, so it is safe to run against any chat the bot can post to.
//
// Usage (the bot must be able to message the target chat):
//   pnpm test:image <chatId> [page] [baseUrlTemplate]
//     chatId           where to send (your numeric Telegram id, from
//                      @userinfobot, or a channel id like -1001234567890)
//     page             Mushaf page 1..604 (default 1)
//     baseUrlTemplate  overrides MUSHAF_IMAGE_BASE_URL for this run, e.g.
//                      "https://your-host.example/mushaf/{page3}.png"
//
// Example:
//   pnpm test:image 123456789 50

import { Bot, InputFile } from 'grammy';
import { loadEnv, mushafImageSource, isHttpSource, isValidPage, toArabicDigits } from '../src/core';

// Read the single root .env, like every other script and the bot itself.
loadEnv();

async function main(): Promise<void> {
  const [chatArg, pageArg, urlArg] = process.argv.slice(2);

  const token = process.env.BOT_TOKEN?.trim();
  if (!token) throw new Error('BOT_TOKEN is missing. Set it in the root .env first.');

  if (!chatArg) {
    console.log('Usage: pnpm test:image <chatId> [page] [baseUrlTemplate]');
    console.log('  chatId           your numeric Telegram id (from @userinfobot) or a channel id');
    console.log('  page             Mushaf page 1..604 (default 1)');
    console.log(
      '  baseUrlTemplate  overrides MUSHAF_IMAGE_BASE_URL, e.g. https://host/{page3}.png',
    );
    process.exit(1);
  }

  const chatId = Number(chatArg);
  if (!Number.isFinite(chatId)) throw new Error(`Bad chat id: "${chatArg}" (expected a number).`);

  const page = pageArg ? Number(pageArg) : 1;
  if (!isValidPage(page)) throw new Error(`Page must be 1..604, got "${pageArg}".`);

  const template = (urlArg ?? process.env.MUSHAF_IMAGE_BASE_URL ?? '').trim();
  if (!template) {
    throw new Error(
      'No image source. Pass a URL template as the 3rd argument, or set ' +
        'MUSHAF_IMAGE_BASE_URL in .env (e.g. https://your-host.example/mushaf/{page3}.png).',
    );
  }

  // mushafImageSource throws on a template with no {page}/{page3} placeholder,
  // so a typo is caught here rather than producing a wrong source.
  const source = mushafImageSource(template, page);
  // Match the bot: an http(s) URL goes as a string (Telegram fetches it); a
  // local path is uploaded from disk via InputFile.
  const photo = isHttpSource(source) ? source : new InputFile(source);
  console.log(`Sending Mushaf page ${page} as a photo to chat ${chatId}`);
  console.log(`  source: ${source}${isHttpSource(source) ? ' (URL)' : ' (local file upload)'}\n`);

  const bot = new Bot(token);
  const caption = `🧪 اختبار: صفحة ${toArabicDigits(page)}`;
  const message = await bot.api.sendPhoto(chatId, photo, { caption });

  const sizes = message.photo ?? [];
  const fileId = sizes.length > 0 ? sizes[sizes.length - 1]!.file_id : '(none returned)';
  console.log('Sent. Check the chat to confirm the page looks correct.');
  console.log(`file_id (what the bot caches for next time): ${fileId}`);
}

main().catch((err) => {
  console.error('\nFailed:', err instanceof Error ? err.message : err);
  console.error(
    'Common causes: the bot cannot message that chat (start it / add it as a channel admin), ' +
      "the URL is not a reachable image, or the file is over Telegram's 5 MB URL limit.",
  );
  process.exit(1);
});
