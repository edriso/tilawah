import type { Bot, Context, InputFile } from 'grammy';
import { GrammyError } from 'grammy';
import type { Message } from 'grammy/types';
import type { SendResult } from './send';
import { logger } from './logger';

// Sending a Mushaf page as a photo, for the optional "image" delivery format.
// This mirrors the plain-text sender in the kernel (telegram-bot-kit/send):
// same SendResult meaning (ok / blocked / failed) and the same single 429
// retry, so the delivery loop treats text and image identically. The one extra
// thing it returns is the Telegram file_id of the sent photo, so the caller can
// cache it and reference it on later sends instead of re-fetching the source.

const MAX_RETRY_AFTER_SECONDS = 30;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface PhotoSendResult {
  result: SendResult;
  /** The file_id of the sent photo (Telegram's largest size), when delivered.
   *  Undefined on a failure or if Telegram returned no photo sizes. */
  fileId?: string;
}

/** The file_id of the largest size in a sent photo message, if any. Telegram
 *  returns several sizes; the last is the largest, and a file_id from any size
 *  can be reused to resend the original photo. */
function largestPhotoFileId(message: Message): string | undefined {
  const sizes = message.photo;
  return sizes && sizes.length > 0 ? sizes[sizes.length - 1]!.file_id : undefined;
}

/**
 * Send one photo to a chat. `photo` is a URL (Telegram fetches it), a cached
 * file_id (Telegram resends it), or an InputFile (the bot uploads a local file
 * itself, for self-hosted images on a bot with no public URL). No parse_mode:
 * the caption is the plain page banner, like the text format.
 *
 * Returns the same SendResult as the text sender:
 *   'ok'      - delivered (with the photo's file_id to cache).
 *   'blocked' - 403; the caller marks a user blocked so we stop trying.
 *   'failed'  - any other error (transient); the caller does not advance.
 * A 429 is waited out once (within the cap), like the text sender.
 */
export async function sendPhoto(
  bot: Bot<Context>,
  chatId: bigint,
  photo: string | InputFile,
  caption?: string,
): Promise<PhotoSendResult> {
  const send = () => bot.api.sendPhoto(Number(chatId), photo, caption ? { caption } : {});
  try {
    return { result: 'ok', fileId: largestPhotoFileId(await send()) };
  } catch (err) {
    if (err instanceof GrammyError && err.error_code === 403) {
      logger.info('Subscriber has blocked the bot', { chatId: String(chatId) });
      return { result: 'blocked' };
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
          return { result: 'ok', fileId: largestPhotoFileId(await send()) };
        } catch (retryErr) {
          logger.error('Photo send failed after retry', {
            chatId: String(chatId),
            error: String(retryErr),
          });
          return { result: 'failed' };
        }
      }
    }
    logger.error('Failed to send photo', { chatId: String(chatId), error: String(err) });
    return { result: 'failed' };
  }
}
