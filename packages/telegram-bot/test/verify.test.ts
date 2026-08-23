import { afterEach, describe, expect, test } from 'bun:test';
import { TelegramTokenError, verifyTelegramBotToken } from '../src/verify.ts';

const FAKE_TOKEN = '1234567:fake-telegram-bot-token-not-real';

const realFetch = globalThis.fetch;

let urls: string[] = [];

function stubFetch(status: number, body: unknown): void {
  globalThis.fetch = ((input: RequestInfo | URL) => {
    urls.push(String(input));
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  }) as typeof globalThis.fetch;
}

afterEach(() => {
  globalThis.fetch = realFetch;
  urls = [];
});

describe('verifyTelegramBotToken', () => {
  test('returns the bot identity from getMe', async () => {
    stubFetch(200, {
      ok: true,
      result: { id: 1234567, username: 'fakebot', is_bot: true },
    });
    expect(await verifyTelegramBotToken(FAKE_TOKEN)).toEqual({
      botId: 1234567,
      username: 'fakebot',
    });
    expect(urls[0]).toBe(`https://api.telegram.org/bot${FAKE_TOKEN}/getMe`);
  });

  test('a rejected token throws without echoing the token', async () => {
    stubFetch(401, { ok: false, description: 'Unauthorized' });
    const err = await verifyTelegramBotToken(FAKE_TOKEN).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TelegramTokenError);
    expect((err as Error).message).toBe('Telegram rejected that bot token');
    expect((err as Error).message).not.toContain(FAKE_TOKEN);
  });

  test('a user session rather than a bot is refused', async () => {
    stubFetch(200, { ok: true, result: { id: 7, is_bot: false } });
    const err = await verifyTelegramBotToken(FAKE_TOKEN).catch((e: unknown) => e);
    expect((err as Error).message).toContain('not belong to a Telegram bot');
  });

  test('a body Telegram did not shape as expected is refused', async () => {
    stubFetch(200, 'not an object');
    const err = await verifyTelegramBotToken(FAKE_TOKEN).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TelegramTokenError);
  });

  test('an unreachable Telegram API is a clear error, not a silent pass', async () => {
    globalThis.fetch = (() =>
      Promise.reject(new Error('connect ETIMEDOUT'))) as typeof globalThis.fetch;
    const err = await verifyTelegramBotToken(FAKE_TOKEN).catch((e: unknown) => e);
    expect((err as Error).message).toContain('could not reach');
  });

  test('a missing username is reported as blank, not as a failure', async () => {
    stubFetch(200, { ok: true, result: { id: 42, is_bot: true } });
    expect((await verifyTelegramBotToken(FAKE_TOKEN)).username).toBe('');
  });
});
