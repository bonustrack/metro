import { describe, expect, spyOn, test } from 'bun:test';
import { log } from '@metro-labs/core/log';
import type { FetchLike } from '@metro-labs/core/stations/oauth';
import { EXPO_PUSH_URL, MEMBERS_TTL_MS, PUSH_BATCH_MAX, PushSender, type PushNote } from '../src/push/sender.ts';

const OWNER = 'org_01TESTOWNER000000';
const NOTE: PushNote = { title: 'Emma needs your approval', body: 'Update page on Notion', url: `https://metro.box/#/${OWNER}/agent000001/approvals/abcde` };

const tokenOf = (n: number): string => `ExponentPushToken[device${String(n).padStart(6, '0')}]`;

interface Sent {
  url: string;
  headers: Record<string, string>;
  messages: Record<string, unknown>[];
}

interface FakeExpo {
  fetch: FetchLike;
  sent: Sent[];
}

function fakeExpo(answer: (messages: Record<string, unknown>[]) => Response | Promise<Response>): FakeExpo {
  const sent: Sent[] = [];
  return {
    sent,
    fetch: async (url, init) => {
      const messages = JSON.parse(String(init?.body)) as Record<string, unknown>[];
      sent.push({ url, headers: init?.headers as Record<string, string>, messages });
      return answer(messages);
    },
  };
}

const tickets = (messages: Record<string, unknown>[], gone: Set<string> = new Set()): Response =>
  Response.json({
    data: messages.map((message) =>
      gone.has(String(message.to)) ? { status: 'error', message: `"${String(message.to)}" is not a registered push notification recipient`, details: { error: 'DeviceNotRegistered' } } : { status: 'ok', id: 'ticket' },
    ),
  });

interface Store {
  tokens: string[];
  dropped: string[][];
  asked: string[][];
}

function sender(expo: FakeExpo, store: Store, over: Partial<ConstructorParameters<typeof PushSender>[0]> = {}): PushSender {
  return new PushSender({
    fetch: expo.fetch,
    accessToken: null,
    members: async () => ['user_01ALICE', 'user_01BOB'],
    devices: {
      tokensOf: async (users) => {
        store.asked.push(users);
        return store.tokens;
      },
      drop: async (tokens) => {
        store.dropped.push(tokens);
        return tokens.length;
      },
    },
    now: () => 0,
    ...over,
  });
}

const storeOf = (count: number): Store => ({ tokens: Array.from({ length: count }, (_, n) => tokenOf(n)), dropped: [], asked: [] });

describe('the phone notification sender', () => {
  test(`sends to every device of the members, ${String(PUSH_BATCH_MAX)} at most per request, on the approvals channel`, async () => {
    const expo = fakeExpo((messages) => tickets(messages));
    const store = storeOf(250);
    const outcome = await sender(expo, store).notify(OWNER, NOTE);
    expect(outcome).toEqual({ devices: 250, sent: 250, failed: 0, dropped: 0 });
    expect(store.asked).toEqual([['user_01ALICE', 'user_01BOB']]);
    expect(expo.sent.map((batch) => batch.messages.length)).toEqual([100, 100, 50]);
    expect(expo.sent.every((batch) => batch.url === EXPO_PUSH_URL)).toBe(true);
    expect(expo.sent[0]?.messages[0]).toEqual({ to: tokenOf(0), title: NOTE.title, body: NOTE.body, data: { url: NOTE.url }, channelId: 'approvals', priority: 'high', sound: 'default' });
    expect(expo.sent.flatMap((batch) => batch.messages.map((message) => message.to))).toEqual(store.tokens);
  });

  test('sends nothing when no member has a device', async () => {
    const expo = fakeExpo((messages) => tickets(messages));
    expect(await sender(expo, storeOf(0)).notify(OWNER, NOTE)).toEqual({ devices: 0, sent: 0, failed: 0, dropped: 0 });
    expect(expo.sent).toEqual([]);
  });

  test('drops the devices Expo reports as no longer registered, and only those', async () => {
    const store = storeOf(3);
    const expo = fakeExpo((messages) => tickets(messages, new Set([tokenOf(1)])));
    expect(await sender(expo, store).notify(OWNER, NOTE)).toEqual({ devices: 3, sent: 2, failed: 1, dropped: 1 });
    expect(store.dropped).toEqual([[tokenOf(1)]]);
  });

  test('sends the Expo access token only when one is set', async () => {
    const expo = fakeExpo((messages) => tickets(messages));
    await sender(expo, storeOf(1)).notify(OWNER, NOTE);
    await sender(expo, storeOf(1), { accessToken: 'expo-secret' }).notify(OWNER, NOTE);
    expect(expo.sent[0]?.headers.authorization).toBeUndefined();
    expect(expo.sent[1]?.headers.authorization).toBe('Bearer expo-secret');
  });

  test('reads the members again only after a minute', async () => {
    let now = 0;
    let reads = 0;
    const expo = fakeExpo((messages) => tickets(messages));
    const push = sender(expo, storeOf(1), { now: () => now, members: async () => { reads += 1; return ['user_01ALICE']; } });
    await push.notify(OWNER, NOTE);
    now = MEMBERS_TTL_MS - 1;
    await push.notify(OWNER, NOTE);
    expect(reads).toBe(1);
    now = MEMBERS_TTL_MS;
    await push.notify(OWNER, NOTE);
    expect(reads).toBe(2);
  });

  test('a refused batch, an unreachable Expo or a timeout fails those devices and the next batch still goes', async () => {
    let calls = 0;
    const expo = fakeExpo((messages) => {
      calls += 1;
      if (calls === 1) return new Response('{"errors":[{"code":"PUSH_TOO_MANY_EXPERIENCE_IDS"}]}', { status: 400 });
      if (calls === 2) throw new TypeError('fetch failed');
      return tickets(messages);
    });
    expect(await sender(expo, storeOf(250)).notify(OWNER, NOTE)).toEqual({ devices: 250, sent: 50, failed: 200, dropped: 0 });
    const hung: FetchLike = (_url, init) => new Promise((_resolve, reject) => { init?.signal?.addEventListener('abort', () => { reject(new DOMException('timed out', 'TimeoutError')); }); });
    expect(await sender({ fetch: hung, sent: [] }, storeOf(1), { timeoutMs: 20 }).notify(OWNER, NOTE)).toEqual({ devices: 1, sent: 0, failed: 1, dropped: 0 });
  });

  test('no log line carries a token or the notification text', async () => {
    const lines: string[] = [];
    const record = (...args: unknown[]): void => { lines.push(JSON.stringify(args)); };
    const info = spyOn(log, 'info').mockImplementation(record);
    const warn = spyOn(log, 'warn').mockImplementation(record);
    try {
      const store = storeOf(2);
      let calls = 0;
      const expo = fakeExpo((messages) => {
        calls += 1;
        if (calls === 1) return new Response('{}', { status: 503 });
        if (calls === 2) throw new TypeError(`could not reach ${tokenOf(1)}`);
        return tickets(messages, new Set([tokenOf(0)]));
      });
      const push = sender(expo, store);
      for (let i = 0; i < 3; i += 1) await push.notify(OWNER, NOTE);
    } finally {
      info.mockRestore();
      warn.mockRestore();
    }
    expect(lines.length).toBeGreaterThanOrEqual(2);
    const all = lines.join('\n');
    for (const secret of [tokenOf(0), tokenOf(1), NOTE.title, NOTE.body, NOTE.url, 'Emma', 'Notion']) expect(all).not.toContain(secret);
  });
});
