import { afterEach, describe, expect, test } from 'bun:test';
import { DiscordTokenError, verifyDiscordBotToken } from '../src/verify.ts';

const FAKE_TOKEN = 'fake-discord-token-not-real';
const MESSAGE_CONTENT_LIMITED = 1 << 19;

const realFetch = globalThis.fetch;

type Reply = { status: number; body: unknown };

let calls: { url: string; auth: string | null }[] = [];

function stubFetch(replies: Record<string, Reply>): void {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    calls.push({ url, auth: headers.get('authorization') });
    const path = url.replace('https://discord.com/api/v10', '');
    const reply = replies[path] ?? { status: 404, body: {} };
    return Promise.resolve(
      new Response(JSON.stringify(reply.body), {
        status: reply.status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  }) as typeof globalThis.fetch;
}

afterEach(() => {
  globalThis.fetch = realFetch;
  calls = [];
});

const ok = (flags: number): Record<string, Reply> => ({
  '/users/@me': {
    status: 200,
    body: { id: '900000000000000001', username: 'fakebot', bot: true },
  },
  '/applications/@me': { status: 200, body: { flags } },
});

describe('verifyDiscordBotToken', () => {
  test('returns the bot identity and authenticates as a bot', async () => {
    stubFetch(ok(MESSAGE_CONTENT_LIMITED));
    const bot = await verifyDiscordBotToken(FAKE_TOKEN);
    expect(bot).toEqual({
      userId: '900000000000000001',
      username: 'fakebot',
      messageContent: true,
    });
    expect(calls[0]?.auth).toBe(`Bot ${FAKE_TOKEN}`);
  });

  test('reports a missing Message Content intent instead of failing at boot', async () => {
    stubFetch(ok(0));
    expect((await verifyDiscordBotToken(FAKE_TOKEN)).messageContent).toBe(false);
  });

  test('an unreadable application object is not treated as a missing intent', async () => {
    stubFetch({
      ...ok(0),
      '/applications/@me': { status: 403, body: {} },
    });
    expect((await verifyDiscordBotToken(FAKE_TOKEN)).messageContent).toBe(true);
  });

  test('a rejected token throws without echoing the token', async () => {
    stubFetch({ '/users/@me': { status: 401, body: { message: '401: Unauthorized' } } });
    const err = await verifyDiscordBotToken(FAKE_TOKEN).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DiscordTokenError);
    expect((err as Error).message).toBe('Discord rejected that bot token');
    expect((err as Error).message).not.toContain(FAKE_TOKEN);
  });

  test('a user token that is not a bot is refused', async () => {
    stubFetch({
      '/users/@me': { status: 200, body: { id: '1', username: 'a-person' } },
    });
    const err = await verifyDiscordBotToken(FAKE_TOKEN).catch((e: unknown) => e);
    expect((err as Error).message).toContain('not a bot');
  });

  test('an unreachable Discord API is a clear error, not a silent pass', async () => {
    globalThis.fetch = (() =>
      Promise.reject(new Error('getaddrinfo ENOTFOUND'))) as typeof globalThis.fetch;
    const err = await verifyDiscordBotToken(FAKE_TOKEN).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DiscordTokenError);
    expect((err as Error).message).toContain('could not reach');
  });

  test('a 500 from Discord is surfaced with its status', async () => {
    stubFetch({ '/users/@me': { status: 502, body: {} } });
    const err = await verifyDiscordBotToken(FAKE_TOKEN).catch((e: unknown) => e);
    expect((err as Error).message).toContain('502');
  });
});
