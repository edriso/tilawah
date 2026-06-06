import { describe, it, expect, vi } from 'vitest';
import { GrammyError } from 'grammy';

vi.mock('./logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { sendPhoto, sendPhotoAlbum } from './send-photo';

/** Build a GrammyError with a given HTTP error_code (and optional retry_after),
 *  so the 403/429 branches can be exercised exactly like a real Telegram error. */
function grammyError(code: number, retryAfter?: number): GrammyError {
  return new GrammyError(
    `Call failed`,
    {
      ok: false,
      error_code: code,
      description: 'x',
      ...(retryAfter !== undefined ? { parameters: { retry_after: retryAfter } } : {}),
    },
    'sendPhoto',
    {},
  );
}

// A minimal fake bot exposing just api.sendPhoto. Returns the spy separately so
// we can assert on it without fighting the grammy Bot type (cast to never).
function botWith(impl: (...args: unknown[]) => unknown) {
  const spy = vi.fn(impl);
  return { bot: { api: { sendPhoto: spy } } as never, spy };
}

function botWithGroup(impl: (...args: unknown[]) => unknown) {
  const spy = vi.fn(impl);
  return { bot: { api: { sendMediaGroup: spy } } as never, spy };
}

describe('sendPhoto', () => {
  it('returns ok with the LARGEST size file_id', async () => {
    const { bot } = botWith(async () => ({ photo: [{ file_id: 'small' }, { file_id: 'big' }] }));
    const r = await sendPhoto(bot, 123n, 'https://x/1.jpg', 'cap');
    expect(r).toEqual({ result: 'ok', fileId: 'big' });
  });

  it('returns ok with no file_id when Telegram returns no photo sizes', async () => {
    const { bot } = botWith(async () => ({}));
    const r = await sendPhoto(bot, 1n, 'https://x/1.jpg');
    expect(r).toEqual({ result: 'ok', fileId: undefined });
  });

  it('maps a generic (non-Grammy) error to failed', async () => {
    const { bot } = botWith(async () => {
      throw new Error('network down');
    });
    const r = await sendPhoto(bot, 1n, 'https://x/1.jpg');
    expect(r).toEqual({ result: 'failed' });
  });

  it('passes the caption through, and converts the chat id to a number', async () => {
    const { bot, spy } = botWith(async () => ({ photo: [{ file_id: 'f' }] }));
    await sendPhoto(bot, 5n, 'https://x/1.jpg', 'hello');
    expect(spy).toHaveBeenCalledWith(5, 'https://x/1.jpg', { caption: 'hello' });
  });

  it('omits the caption option when none is given', async () => {
    const { bot, spy } = botWith(async () => ({ photo: [{ file_id: 'f' }] }));
    await sendPhoto(bot, 5n, 'https://x/1.jpg');
    expect(spy).toHaveBeenCalledWith(5, 'https://x/1.jpg', {});
  });

  it('maps a 403 to blocked (so the caller stops trying)', async () => {
    const { bot, spy } = botWith(async () => {
      throw grammyError(403);
    });
    const r = await sendPhoto(bot, 1n, 'https://x/1.jpg');
    expect(r).toEqual({ result: 'blocked' });
    expect(spy).toHaveBeenCalledTimes(1); // no retry on a block
  });

  it('waits out a 429 and succeeds on the single retry', async () => {
    let calls = 0;
    const { bot } = botWith(async () => {
      calls++;
      if (calls === 1) throw grammyError(429, 0); // retry_after 0 → instant
      return { photo: [{ file_id: 'after-retry' }] };
    });
    const r = await sendPhoto(bot, 1n, 'https://x/1.jpg');
    expect(r).toEqual({ result: 'ok', fileId: 'after-retry' });
    expect(calls).toBe(2);
  });

  it('fails if the retry after a 429 also fails', async () => {
    const { bot, spy } = botWith(async () => {
      throw grammyError(429, 0);
    });
    const r = await sendPhoto(bot, 1n, 'https://x/1.jpg');
    expect(r).toEqual({ result: 'failed' });
    expect(spy).toHaveBeenCalledTimes(2); // original + one retry
  });

  it('does not retry a 429 whose retry_after exceeds the cap', async () => {
    const { bot, spy } = botWith(async () => {
      throw grammyError(429, 31); // > MAX_RETRY_AFTER_SECONDS (30)
    });
    const r = await sendPhoto(bot, 1n, 'https://x/1.jpg');
    expect(r).toEqual({ result: 'failed' });
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('sendPhotoAlbum', () => {
  it('returns ok with the largest file_id of each sent photo, in order', async () => {
    const { bot } = botWithGroup(async () => [
      { photo: [{ file_id: 'a-small' }, { file_id: 'a-big' }] },
      { photo: [{ file_id: 'b-big' }] },
    ]);
    const r = await sendPhotoAlbum(bot, 1n, [{ media: 'u1', caption: 'cap' }, { media: 'u2' }]);
    expect(r).toEqual({ result: 'ok', fileIds: ['a-big', 'b-big'] });
  });

  it('maps a generic (non-Grammy) error to failed with no file_ids', async () => {
    const { bot } = botWithGroup(async () => {
      throw new Error('boom');
    });
    const r = await sendPhotoAlbum(bot, 1n, [{ media: 'u1' }, { media: 'u2' }]);
    expect(r).toEqual({ result: 'failed', fileIds: [] });
  });

  it('maps a 403 to blocked with no file_ids', async () => {
    const { bot, spy } = botWithGroup(async () => {
      throw grammyError(403);
    });
    const r = await sendPhotoAlbum(bot, 1n, [{ media: 'u1' }, { media: 'u2' }]);
    expect(r).toEqual({ result: 'blocked', fileIds: [] });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('waits out a 429 and succeeds on the single retry', async () => {
    let calls = 0;
    const { bot } = botWithGroup(async () => {
      calls++;
      if (calls === 1) throw grammyError(429, 0);
      return [{ photo: [{ file_id: 'a' }] }, { photo: [{ file_id: 'b' }] }];
    });
    const r = await sendPhotoAlbum(bot, 1n, [{ media: 'u1' }, { media: 'u2' }]);
    expect(r).toEqual({ result: 'ok', fileIds: ['a', 'b'] });
    expect(calls).toBe(2);
  });
});
