/**
 * Burst delivery: a mid-session burst of N distinct inbound messages must all
 * reach the claude/channel notification sink, across stations and interleaved
 * with non-routable bus traffic (outbound sends, react/reply events).
 *
 * Drives the real path: publishEvent -> bus -> ChannelRelay -> InboundRelay.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { InboundRelay } from '../src/channels/inbound.ts';
import { ChannelRelay } from '../src/channels/relay.ts';
import {
  classifyEvent,
  publishEvent,
  type MetroEvent,
} from '../src/daemon/events.ts';
import type { Line } from '../src/stations/lines.ts';

type Notif = { method: string; params: Record<string, unknown> };

function makeRelay(stations: string[]): {
  relay: InboundRelay;
  notifs: Notif[];
} {
  const notifs: Notif[] = [];
  const fakeMcp = {
    notification: (n: Notif) => {
      notifs.push(n);
      return Promise.resolve();
    },
  };
  const relay = new InboundRelay({
    mcp: fakeMcp as never,
    log: () => {},
    getStations: () => new Set(stations),
    senderAllowed: () => true,
    metroSend: () => Promise.resolve(),
  });
  return { relay, notifs };
}

const drain = (): Promise<void> => new Promise((r) => setTimeout(r, 100));

let stop: (() => void) | undefined;
afterEach(() => {
  stop?.();
  stop = undefined;
});

interface MsgSpec {
  station: string;
  line: string;
  from: string;
  messageId: string;
  text: string;
}

function inbound(s: MsgSpec): MetroEvent {
  return {
    id: `id_${s.messageId}`,
    ts: '2026-06-25T00:00:00.000Z',
    station: s.station,
    line: s.line as Line,
    lineName: 'chat',
    from: s.from as Line,
    to: s.line as Line,
    text: s.text,
    messageId: s.messageId,
    event: { type: 'msg' },
  };
}

function channelContents(notifs: Notif[]): string[] {
  return notifs
    .filter((n) => n.method === 'notifications/claude/channel')
    .map((n) => String(n.params.content));
}

describe('burst delivery', () => {
  test('10 distinct rapid messages on one discord chat all delivered', async () => {
    const { relay, notifs } = makeRelay(['discord']);
    stop = new ChannelRelay({ relay, log: () => {} }).start();

    for (let i = 1; i <= 10; i++) {
      publishEvent(
        inbound({
          station: 'discord',
          line: 'metro://discord/g/1/c/2',
          from: 'metro://discord/u/alice',
          messageId: `disc-${i}`,
          text: String(i),
        }),
      );
    }
    await drain();

    const got = channelContents(notifs);
    expect(got.sort((a, b) => Number(a) - Number(b))).toEqual(
      Array.from({ length: 10 }, (_, i) => String(i + 1)),
    );
  });

  test('burst interleaved with non-routable bus traffic, all delivered', async () => {
    const { relay, notifs } = makeRelay(['telegram']);
    stop = new ChannelRelay({ relay, log: () => {} }).start();

    for (let i = 1; i <= 10; i++) {
      publishEvent(
        inbound({
          station: 'telegram',
          line: 'metro://telegram/acct/-100/5',
          from: 'metro://telegram/u/bob',
          messageId: `tg-${i}`,
          text: String(i),
        }),
      );
      publishEvent({
        id: `out_${i}`,
        ts: '2026-06-25T00:00:00.000Z',
        station: 'telegram',
        line: 'metro://telegram/acct/-100/5' as Line,
        from: 'metro://claude/main' as Line,
        to: 'metro://telegram/acct/-100/5' as Line,
        text: `ack ${i}`,
        event: { type: 'msg' },
      });
    }
    await drain();

    const got = channelContents(notifs);
    expect(got.sort((a, b) => Number(a) - Number(b))).toEqual(
      Array.from({ length: 10 }, (_, i) => String(i + 1)),
    );
  });

  test('bursts across three stations interleaved all delivered', async () => {
    const { relay, notifs } = makeRelay([
      'discord',
      'telegram',
      'telegram-user',
    ]);
    stop = new ChannelRelay({ relay, log: () => {} }).start();

    const lines: Record<string, { line: string; from: string }> = {
      discord: { line: 'metro://discord/g/1/c/2', from: 'metro://discord/u/a' },
      telegram: {
        line: 'metro://telegram/acct/-100/5',
        from: 'metro://telegram/u/b',
      },
      'telegram-user': {
        line: 'metro://telegram-user/acct/777',
        from: 'metro://telegram-user/u/c',
      },
    };
    const stations = Object.keys(lines);
    for (let i = 1; i <= 10; i++) {
      for (const st of stations) {
        publishEvent(
          inbound({
            station: st,
            line: lines[st]!.line,
            from: lines[st]!.from,
            messageId: `${st}-${i}`,
            text: `${st}#${i}`,
          }),
        );
      }
    }
    await drain();

    const got = channelContents(notifs);
    expect(got.length).toBe(30);
    for (const st of stations)
      for (let i = 1; i <= 10; i++) expect(got).toContain(`${st}#${i}`);
  });

  test('genuine duplicate (same messageId re-emitted) is still deduped', async () => {
    const { relay, notifs } = makeRelay(['discord']);
    stop = new ChannelRelay({ relay, log: () => {} }).start();

    const e = inbound({
      station: 'discord',
      line: 'metro://discord/g/1/c/2',
      from: 'metro://discord/u/alice',
      messageId: 'dup-1',
      text: 'only once',
    });
    publishEvent(e);
    publishEvent({ ...e, id: 'id_dup_again' });
    await drain();

    expect(channelContents(notifs)).toEqual(['only once']);
  });
});

function replyMsg(s: MsgSpec & { replyTo: string }): MetroEvent {
  return { ...inbound(s), replyTo: s.replyTo, event: classifyEvent({ ...inbound(s), replyTo: s.replyTo }) };
}

describe('burst with reply-typed messages (the burst-drop bug)', () => {
  test('a burst where half the messages are replies still delivers all 10', async () => {
    const { relay, notifs } = makeRelay(['discord']);
    stop = new ChannelRelay({ relay, log: () => {} }).start();

    for (let i = 1; i <= 10; i++) {
      const spec = {
        station: 'discord',
        line: 'metro://discord/g/1/c/2',
        from: 'metro://discord/u/alice',
        messageId: `r-${i}`,
        text: String(i),
      };
      publishEvent(
        i % 2 === 0
          ? replyMsg({ ...spec, replyTo: `r-${i - 1}` })
          : inbound(spec),
      );
    }
    await drain();

    const got = channelContents(notifs);
    expect(got.sort((a, b) => Number(a) - Number(b))).toEqual(
      Array.from({ length: 10 }, (_, i) => String(i + 1)),
    );
  });

  test('a single reply message reaches the channel sink', async () => {
    const { relay, notifs } = makeRelay(['telegram']);
    stop = new ChannelRelay({ relay, log: () => {} }).start();

    publishEvent(
      replyMsg({
        station: 'telegram',
        line: 'metro://telegram/acct/-100/5',
        from: 'metro://telegram/u/bob',
        messageId: 'tg-reply-1',
        text: 'this is a reply',
        replyTo: 'tg-0',
      }),
    );
    await drain();

    expect(channelContents(notifs)).toEqual(['this is a reply']);
  });
});
