import { afterEach, describe, expect, test } from 'bun:test';
import { channelContents, makeRelay } from './relay-fixture.ts';
import { settle } from './wait.ts';
import { ChannelRelay } from '../src/channels/relay.ts';
import { publishEvent, type MetroEvent } from '@metro-labs/core/events';
import type { Line } from '@metro-labs/core/lines';

const drain = (): Promise<void> => settle(200);

let stop: (() => void) | undefined;
afterEach(() => {
  stop?.();
  stop = undefined;
});

function inbound(messageId: string, text: string): MetroEvent {
  return {
    id: `id_${messageId}`,
    ts: '2026-06-25T00:00:00.000Z',
    station: 'discord-bot',
    line: 'metro://discord-bot/g/1/c/2' as Line,
    lineName: 'chat',
    from: 'metro://discord-bot/u/alice' as Line,
    to: 'metro://discord-bot/g/1/c/2' as Line,
    text,
    messageId,
    event: { type: 'msg' },
  };
}

describe('burst with async delivery + mid-burst rebind', () => {
  test('async sink: 10 rapid events all delivered once, in order', async () => {
    const { relay, notifs } = makeRelay(['discord-bot'], () => settle(5));
    const channel = new ChannelRelay({ relay, log: () => {}, inScope: () => true });
    stop = channel.start();

    for (let i = 1; i <= 10; i++) publishEvent(inbound(`a-${i}`, String(i)));
    await drain();

    expect(channelContents(notifs)).toEqual(
      Array.from({ length: 10 }, (_, i) => String(i + 1)),
    );
  });

  test('rebind in the middle of an async burst: every event once, no dups', async () => {
    const { relay, notifs } = makeRelay(['discord-bot'], () => settle(5));
    const channel = new ChannelRelay({ relay, log: () => {}, inScope: () => true });
    stop = channel.start();

    for (let i = 1; i <= 10; i++) publishEvent(inbound(`b-${i}`, String(i)));
    await settle(12);
    channel.replayMissed();
    await drain();

    const got = channelContents(notifs);
    expect(got.sort((a, b) => Number(a) - Number(b))).toEqual(
      Array.from({ length: 10 }, (_, i) => String(i + 1)),
    );
  });

  test('a notify() that rejects once: chain recovers, later events deliver', async () => {
    let calls = 0;
    const { relay, notifs } = makeRelay(['discord-bot'], () => {
      calls += 1;
      if (calls === 3) return Promise.reject(new Error('transport down'));
      return settle(5);
    });
    const channel = new ChannelRelay({ relay, log: () => {}, inScope: () => true });
    stop = channel.start();

    for (let i = 1; i <= 10; i++) publishEvent(inbound(`c-${i}`, String(i)));
    await drain();
    channel.replayMissed();
    await drain();

    const got = channelContents(notifs);
    for (let i = 1; i <= 10; i++) expect(got).toContain(String(i));
    expect(new Set(got).size).toBe(10);
  });
});
