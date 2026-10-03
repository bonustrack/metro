import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { ConsentState, Conversations } from '@xmtp/node-sdk';
import { NetworkBackoff } from '../src/network.ts';
import { streamMessages } from '../src/stream.ts';

const stop = new Error('test finished');
type Options = Parameters<Parameters<typeof streamMessages<string>>[0]['streamAllMessages']>[0];

function fixture(limit = 1) {
  let now = 1_000_000;
  const delays: number[] = [];
  const reports: string[] = [];
  const backoff = new NetworkBackoff(() => now);
  const runtime = {
    backoff,
    now: () => now,
    wait: async (ms: number) => {
      delays.push(ms);
      now += ms;
      if (delays.length >= limit) throw stop;
    },
    report: (message: string) => { reports.push(message); },
  };
  return { runtime, delays, reports, advance: (ms: number) => { now += ms; } };
}

function nativeSource(syncAll: () => Promise<unknown>) {
  type Args = ConstructorParameters<typeof Conversations>;
  return new Conversations({} as Args[0], {} as Args[1], { syncAll } as unknown as Args[2]);
}

describe('one XMTP stream and one retry owner', () => {
  test('the train has no duplicate boot sync or periodic all-conversation poll', () => {
    const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
    expect(source).not.toContain('syncAll');
    expect(source).not.toContain('setInterval');
    expect(source).toContain('streamMessages(acct.client.conversations');
  });

  test('an hour-long healthy stream is opened once and every message is handled', async () => {
    const { runtime, advance } = fixture();
    const delivered: string[] = [];
    let starts = 0;
    const source = {
      streamAllMessages: async (options: Options) => {
        starts++;
        expect(options.consentStates).toEqual([ConsentState.Allowed, ConsentState.Unknown]);
        expect(options.retryOnFail).toBe(false);
        expect('disableSync' in options).toBe(false);
        return (async function* () {
          for (let i = 0; i < 60; i++) {
            advance(60_000);
            options.onValue(`message-${i}`);
            yield `message-${i}`;
          }
        })();
      },
    };
    await expect(streamMessages(source, async (message) => { delivered.push(message); }, runtime)).rejects.toBe(stop);
    expect(starts).toBe(1);
    expect(delivered).toHaveLength(60);
    expect(new Set(delivered).size).toBe(60);
  });

  test('messages already accepted are drained even when the real SDK clears its queue on failure', async () => {
    const { runtime } = fixture();
    let push = (_error: Error | null, _value: { id: string } | undefined) => {};
    let fail = () => {};
    let opened = () => {};
    let release = () => {};
    let closes = 0;
    const ready = new Promise<void>((resolve) => { opened = resolve; });
    const hold = new Promise<void>((resolve) => { release = resolve; });
    type Args = ConstructorParameters<typeof Conversations>;
    const native = {
      syncAll: async () => {},
      streamAllMessages: (callback: typeof push, onFail: typeof fail) => {
        push = callback;
        fail = onFail;
        return { waitForReady: async () => {}, end: () => { closes++; }, endAndWait: async () => {}, isClosed: () => closes > 0 };
      },
    };
    const conversations = new Conversations({} as Args[0], {} as Args[1], native as unknown as Args[2]);
    conversations.getMessageById = (id) => ({ id }) as ReturnType<typeof conversations.getMessageById>;
    const source = {
      streamAllMessages: async (options: Parameters<typeof conversations.streamAllMessages>[0]) => {
        const stream = await conversations.streamAllMessages(options);
        opened();
        return stream;
      },
    };
    const delivered: string[] = [];
    const running = streamMessages(source, async (message) => { await hold; delivered.push(message.id); }, runtime);
    await ready;
    push(null, { id: 'first' });
    push(null, { id: 'second' });
    fail();
    release();
    await expect(running).rejects.toBe(stop);
    expect(delivered).toEqual(['first', 'second']);
    expect(closes).toBe(1);
  });

  test('real SDK initialization failures have one full sync per backoff, not an internal retry loop', async () => {
    const { runtime, delays, reports } = fixture(5);
    let syncs = 0;
    const source = nativeSource(async () => {
      syncs++;
      throw new Error('QueryGroupMessages: Some resource has been exhausted');
    });
    await expect(streamMessages(source, async () => {}, runtime)).rejects.toBe(stop);
    expect(syncs).toBe(5);
    expect(delays).toEqual([60_000, 120_000, 240_000, 300_000, 300_000]);
    expect(reports.some((message) => message.includes('QueryGroupMessages'))).toBe(true);
  });

  test('a stream retry-after is shared with tools and is not capped at five minutes', async () => {
    const { runtime, delays } = fixture();
    const source = nativeSource(async () => {
      throw Object.assign(new Error('429'), { headers: new Headers({ 'retry-after': '420' }) });
    });
    runtime.wait = async (ms) => {
      delays.push(ms);
      await expect(runtime.backoff.run(async () => 'must not send')).rejects.toThrow('retry in 420s');
      throw stop;
    };
    await expect(streamMessages(source, async () => {}, runtime)).rejects.toBe(stop);
    expect(delays).toEqual([420_000]);
  });

  test('a tool rate limit prevents a background reconnect from reaching the SDK', async () => {
    const { runtime, delays } = fixture();
    runtime.backoff.note(new Error('GetIdentityUpdates: exceeds rate limit'));
    let calls = 0;
    const source = nativeSource(async () => { calls++; });
    await expect(streamMessages(source, async () => {}, runtime)).rejects.toBe(stop);
    expect(calls).toBe(0);
    expect(delays).toEqual([60_000]);
  });

  test('normal reconnect failures back off, then a healthy minute resets the delay', async () => {
    const { runtime, delays, advance } = fixture(4);
    let starts = 0;
    const source = {
      streamAllMessages: async (options: Options) => {
        starts++;
        if (starts < 4) throw new Error('connection lost');
        return (async function* () { advance(60_000); options.onValue('recovered'); yield 'recovered'; })();
      },
    };
    const messages: string[] = [];
    await expect(streamMessages(source, async (message) => { messages.push(message); }, runtime)).rejects.toBe(stop);
    expect(delays).toEqual([5000, 10_000, 20_000, 5000]);
    expect(messages).toEqual(['recovered']);
  });
});
