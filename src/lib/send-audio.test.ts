import { describe, it, expect, vi } from 'vitest';
import { GrammyError } from 'grammy';

vi.mock('./logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { sendAudio } from './send-audio';

function botWith(impl: (...args: unknown[]) => unknown) {
  const spy = vi.fn(impl);
  return { bot: { api: { sendAudio: spy } } as never, spy };
}

function grammyError(code: number, retryAfter?: number): GrammyError {
  return new GrammyError(
    'Call failed',
    {
      ok: false,
      error_code: code,
      description: 'x',
      ...(retryAfter !== undefined ? { parameters: { retry_after: retryAfter } } : {}),
    },
    'sendAudio',
    {},
  );
}

describe('sendAudio', () => {
  it('returns ok with the audio file_id', async () => {
    const { bot } = botWith(async () => ({ audio: { file_id: 'AUD' } }));
    expect(await sendAudio(bot, 1n, 'https://x/1.mp3', { caption: 'cap' })).toEqual({
      result: 'ok',
      fileId: 'AUD',
    });
  });

  it('falls back to a voice file_id when there is no audio object', async () => {
    const { bot } = botWith(async () => ({ voice: { file_id: 'V' } }));
    expect(await sendAudio(bot, 1n, 'https://x/1.mp3')).toEqual({ result: 'ok', fileId: 'V' });
  });

  it('passes caption, title, and performer and converts the chat id to a number', async () => {
    const { bot, spy } = botWith(async () => ({ audio: { file_id: 'f' } }));
    await sendAudio(bot, 5n, 'https://x/1.mp3', {
      caption: 'hello',
      title: 'الصفحة ٥',
      performer: 'الحصري',
    });
    expect(spy).toHaveBeenCalledWith(5, 'https://x/1.mp3', {
      caption: 'hello',
      title: 'الصفحة ٥',
      performer: 'الحصري',
    });
  });

  it('omits options that are not given (no empty caption/title/performer keys)', async () => {
    const { bot, spy } = botWith(async () => ({ audio: { file_id: 'f' } }));
    await sendAudio(bot, 5n, 'https://x/1.mp3', { title: 'الصفحة ٥' });
    expect(spy).toHaveBeenCalledWith(5, 'https://x/1.mp3', { title: 'الصفحة ٥' });
  });

  it('maps a 403 to blocked (no retry)', async () => {
    const { bot, spy } = botWith(async () => {
      throw grammyError(403);
    });
    expect(await sendAudio(bot, 1n, 'https://x/1.mp3')).toEqual({ result: 'blocked' });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('waits out a 429 then succeeds on the single retry', async () => {
    let calls = 0;
    const { bot } = botWith(async () => {
      calls++;
      if (calls === 1) throw grammyError(429, 0);
      return { audio: { file_id: 'after' } };
    });
    expect(await sendAudio(bot, 1n, 'https://x/1.mp3')).toEqual({ result: 'ok', fileId: 'after' });
    expect(calls).toBe(2);
  });

  it('does not retry a 429 beyond the cap, and maps generic errors to failed', async () => {
    const over = botWith(async () => {
      throw grammyError(429, 31);
    });
    expect(await sendAudio(over.bot, 1n, 'https://x/1.mp3')).toEqual({ result: 'failed' });
    expect(over.spy).toHaveBeenCalledTimes(1);

    const generic = botWith(async () => {
      throw new Error('network down');
    });
    expect(await sendAudio(generic.bot, 1n, 'https://x/1.mp3')).toEqual({ result: 'failed' });
  });
});
