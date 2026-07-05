import { afterEach, describe, expect, test } from 'bun:test';
import { InboundRelay } from '../src/channels/inbound.ts';
import { ChannelRelay } from '../src/channels/relay.ts';
import { publishEvent, type MetroEvent } from '../src/daemon/events.ts';
import type { Line } from '../src/stations/lines.ts';

type Notif = { method: string; params: Record<string, unknown> };

function makeRelay(
  stations: string[],
  notify: (n: Notif) => Promise<void>,
): { relay: InboundRelay; notifs: Notif[] } {
  const notifs: Notif[] = [];
  const fakeMcp = {
    notification: (n: Notif) => {
      notifs.push(n);
      return notify(n);
    },
  };
  const relay = new InboundRelay({
    mcp: fakeMcp as never,
    log: () => {},
    getStations: () => new Set(stations),
    senderAllowed: () => true,
  });
  return { relay, notifs };
}

const tick = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));
const drain = (): Promise<void> => tick(200);

let stop: (() => void) | undefined;
afterEach(() => {
  stop?.();
  stop = undefined;
});

function inbound(messageId: string, text: string): MetroEvent {
  return {
    id: `id_${messageId}`,
    ts: '2026-06-25T00:00:00.000Z',
    station: 'discord',
    line: 'metro://discord/g/1/c/2' as Line,
    lineName: 'chat',
    from: 'metro://discord/u/alice' as Line,
    to: 'metro://discord/g/1/c/2' as Line,
    text,
    messageId,
    event: { type: 'msg' },
  };
}

function contents(notifs: Notif[]): string[] {
  return notifs
    .filter((n) => n.method === 'notifications/claude/channel')
    .map((n) => String(n.params.content));
}

describe('burst with async delivery + mid-burst rebind', () => {
  test('async sink: 10 rapid events all delivered once, in order', async () => {
    const { relay, notifs } = makeRelay(['discord'], () => tick(5));
    const channel = new ChannelRelay({ relay, log: () => {} });
    stop = channel.start();

    for (let i = 1; i <= 10; i++) publishEvent(inbound(`a-${i}`, String(i)));
    await drain();

    expect(contents(notifs)).toEqual(
      Array.from({ length: 10 }, (_, i) => String(i + 1)),
    );
  });

  test('rebind in the middle of an async burst: every event once, no dups', async () => {
    const { relay, notifs } = makeRelay(['discord'], () => tick(5));
    const channel = new ChannelRelay({ relay, log: () => {} });
    stop = channel.start();

    for (let i = 1; i <= 10; i++) publishEvent(inbound(`b-${i}`, String(i)));
    await tick(12);
    channel.replayMissed();
    await drain();

    const got = contents(notifs);
    expect(got.sort((a, b) => Number(a) - Number(b))).toEqual(
      Array.from({ length: 10 }, (_, i) => String(i + 1)),
    );
  });

  test('a notify() that rejects once: chain recovers, later events deliver', async () => {
    let calls = 0;
    const { relay, notifs } = makeRelay(['discord'], () => {
      calls += 1;
      if (calls === 3) return Promise.reject(new Error('transport down'));
      return tick(5);
    });
    const channel = new ChannelRelay({ relay, log: () => {} });
    stop = channel.start();

    for (let i = 1; i <= 10; i++) publishEvent(inbound(`c-${i}`, String(i)));
    await drain();
    channel.replayMissed();
    await drain();

    const got = contents(notifs);
    for (let i = 1; i <= 10; i++) expect(got).toContain(String(i));
    expect(new Set(got).size).toBe(10);
  });
});
