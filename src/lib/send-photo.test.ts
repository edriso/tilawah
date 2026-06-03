import { describe, it, expect, vi } from 'vitest';

vi.mock('./logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { sendPhoto } from './send-photo';

// A minimal fake bot exposing just api.sendPhoto. Returns the spy separately so
// we can assert on it without fighting the grammy Bot type (cast to never).
function botWith(impl: (...args: unknown[]) => unknown) {
  const spy = vi.fn(impl);
  return { bot: { api: { sendPhoto: spy } } as never, spy };
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
});
