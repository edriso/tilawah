import type { Bot, Context, InputFile } from 'grammy';
import { GrammyError, InputMediaBuilder } from 'grammy';
import type { Message } from 'grammy/types';
import type { SendResult } from './send';
import { logger } from './logger';

/** Telegram's media-group (album) size limit: 2 to 10 items per album. */
export const MAX_ALBUM_SIZE = 10;

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

/** One photo in an album: its source (URL, cached file_id, or InputFile) and an
 *  optional caption. Telegram shows only the FIRST item's caption for the
 *  album, so callers set it on the first item alone. */
export interface AlbumPhoto {
  media: string | InputFile;
  caption?: string;
}

export interface AlbumSendResult {
  result: SendResult;
  /** file_id of each sent photo, index-aligned with the input items (so each
   *  page's id can be cached). Empty on a failed/blocked send. */
  fileIds: (string | undefined)[];
}

/**
 * Send 2..10 photos as a single album (media group). The pages arrive in array
 * order, grouped under one notification, which reads like a slice of the Mushaf
 * (each page image already shows its own number, so only the first item carries
 * a caption: the wird lead / starting banner).
 *
 * Atomic: Telegram delivers the whole group or none, so the result is the same
 * SendResult as a single photo (ok / blocked / failed) for the group as a whole.
 * The caller falls back to per-page sending on a 'failed' so one bad page never
 * costs the rest of the wird. A 429 is waited out once, like the single sender.
 */
export async function sendPhotoAlbum(
  bot: Bot<Context>,
  chatId: bigint,
  photos: AlbumPhoto[],
): Promise<AlbumSendResult> {
  const media = photos.map((p) =>
    InputMediaBuilder.photo(p.media, p.caption ? { caption: p.caption } : {}),
  );
  const send = () => bot.api.sendMediaGroup(Number(chatId), media);
  try {
    return { result: 'ok', fileIds: (await send()).map(largestPhotoFileId) };
  } catch (err) {
    if (err instanceof GrammyError && err.error_code === 403) {
      logger.info('Subscriber has blocked the bot', { chatId: String(chatId) });
      return { result: 'blocked', fileIds: [] };
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
          return { result: 'ok', fileIds: (await send()).map(largestPhotoFileId) };
        } catch (retryErr) {
          logger.error('Album send failed after retry', {
            chatId: String(chatId),
            error: String(retryErr),
          });
          return { result: 'failed', fileIds: [] };
        }
      }
    }
    logger.error('Failed to send album', { chatId: String(chatId), error: String(err) });
    return { result: 'failed', fileIds: [] };
  }
}
