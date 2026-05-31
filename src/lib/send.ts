import type { Bot } from 'grammy';
import { GrammyError, type Context } from 'grammy';
import { logger } from './logger';

export type SendResult = 'ok' | 'blocked' | 'failed';

// Cap on how long we wait out a Telegram rate limit before giving up on a
// message. A wird can be several pages (several messages), so a burst may hit
// the per-chat flood limit; we honour one retry-after wait within this cap.
const MAX_RETRY_AFTER_SECONDS = 30;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Send one plain-text message to a chat. No parse_mode on purpose: Quran text
 * contains characters Markdown/HTML parsing would reject with a 400, so plain
 * text is the only safe choice.
 *
 * Returns:
 *   'ok'      - delivered.
 *   'blocked' - the user blocked the bot or deleted the chat (403). The caller
 *               should mark them blocked so we stop trying.
 *   'failed'  - any other error (transient). The caller does not advance the
 *               subscriber, so the same pages are retried next time.
 *
 * On a 429 (too many requests) we wait the server's suggested retry_after once
 * and try again, which smooths out a multi-page burst to one chat.
 */
export async function sendMessage(
  bot: Bot<Context>,
  chatId: bigint,
  text: string,
): Promise<SendResult> {
  try {
    await bot.api.sendMessage(Number(chatId), text);
    return 'ok';
  } catch (err) {
    if (err instanceof GrammyError && err.error_code === 403) {
      logger.info('Subscriber has blocked the bot', { chatId: String(chatId) });
      return 'blocked';
    }
    if (err instanceof GrammyError && err.error_code === 429) {
      const retryAfter = err.parameters?.retry_after ?? 1;
      if (retryAfter <= MAX_RETRY_AFTER_SECONDS) {
        logger.warn('Rate limited, waiting then retrying once', {
          chatId: String(chatId),
          retryAfter,
        });
        await sleep(retryAfter * 1000);
        try {
          await bot.api.sendMessage(Number(chatId), text);
          return 'ok';
        } catch (retryErr) {
          logger.error('Send failed after retry', {
            chatId: String(chatId),
            error: String(retryErr),
          });
          return 'failed';
        }
      }
    }
    logger.error('Failed to send message', { chatId: String(chatId), error: String(err) });
    return 'failed';
  }
}

/**
 * Send several messages to a chat in order (one per page of the wird). Stops
 * at the first failure and returns its result, so the caller does not record
 * the delivery (it will be retried). Returns 'ok' only if every message was
 * delivered.
 */
export async function sendMessages(
  bot: Bot<Context>,
  chatId: bigint,
  texts: string[],
): Promise<SendResult> {
  for (const text of texts) {
    const result = await sendMessage(bot, chatId, text);
    if (result !== 'ok') return result;
  }
  return 'ok';
}
