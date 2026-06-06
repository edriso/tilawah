import type { Bot, Context, InputFile } from 'grammy';
import { GrammyError } from 'grammy';
import type { Message } from 'grammy/types';
import type { SendResult } from './send';
import { logger } from './logger';

// Sending a tajweed lesson's example ayah as an audio clip. The audio twin of
// send-photo.ts: same SendResult meaning (ok / blocked / failed) and the same
// single 429 retry, and it returns the Telegram file_id so the caller can cache
// it (see TajweedAudio) and reference it on later sends instead of re-fetching.

const MAX_RETRY_AFTER_SECONDS = 30;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface AudioSendResult {
  result: SendResult;
  /** The file_id of the sent audio, when delivered; undefined on failure. */
  fileId?: string;
}

function audioFileId(message: Message): string | undefined {
  return message.audio?.file_id ?? message.voice?.file_id;
}

/**
 * Send one audio clip to a chat. `audio` is a URL (Telegram fetches it), a
 * cached file_id (Telegram resends it), or an InputFile (the bot uploads a
 * local file). The caption is the plain lesson banner (no parse_mode).
 *
 * Returns the same SendResult as the text/photo senders:
 *   'ok'      - delivered (with the file_id to cache).
 *   'blocked' - 403; the caller marks a user blocked so we stop trying.
 *   'failed'  - any other error (transient).
 * A 429 is waited out once (within the cap), like the other senders.
 */
export async function sendAudio(
  bot: Bot<Context>,
  chatId: bigint,
  audio: string | InputFile,
  caption?: string,
): Promise<AudioSendResult> {
  const send = () => bot.api.sendAudio(Number(chatId), audio, caption ? { caption } : {});
  try {
    return { result: 'ok', fileId: audioFileId(await send()) };
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
          return { result: 'ok', fileId: audioFileId(await send()) };
        } catch (retryErr) {
          logger.error('Audio send failed after retry', {
            chatId: String(chatId),
            error: String(retryErr),
          });
          return { result: 'failed' };
        }
      }
    }
    logger.error('Failed to send audio', { chatId: String(chatId), error: String(err) });
    return { result: 'failed' };
  }
}
