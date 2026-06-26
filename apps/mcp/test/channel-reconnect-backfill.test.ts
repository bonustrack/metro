import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { ChannelRelay } from '../src/channels/relay.ts';
import { InboundRelay } from '../src/channels/inbound.ts';
import { publishEvent, type MetroEvent } from '../src/daemon/events.ts';
import { asLine } from '../src/stations/lines.ts';

interface Capture {
  contents: string[];
  fail: Set<string>;
}

function makeRelay(cap: Capture): InboundRelay {
  const fakeMcp = {
    notification: (n: { params: { content?: string } }) => {
      const content = n.params.content ?? '';
      if (cap.fail.has(content)) {
        cap.fail.delete(content);
        return Promise.reject(new Error('transport closed'));
      }
      cap.contents.push(content);
      return Promise.resolve();
    },
  };
  return new InboundRelay({
    mcp: fakeMcp as never,
    log: () => {},
    getStations: () => new Set(['discord']),
    senderAllowed: () => true,
    metroSend: () => Promise.resolve(),
  });
}

const msg = (text: string): MetroEvent =>
  ({
    id: `id-${randomUUID()}`,
    ts: new Date().toISOString(),
    station: 'discord',
    line: asLine('metro://discord/acc/chan1'),
    from: asLine('metro://discord/acc/sender1'),
    to: asLine('metro://discord/acc/chan1'),
    text,
    messageId: `m-${randomUUID()}`,
    event: { type: 'msg' },
  }) as unknown as MetroEvent;

const settle = (): Promise<void> =>
  new Promise((r) => setTimeout(r, 30));

describe('channel reconnect backfill', () => {
  test('an event whose delivery fails is replayed (not lost) on reconnect', async () => {
    const cap: Capture = { contents: [], fail: new Set(['during-gap']) };
    const channel = new ChannelRelay({ relay: makeRelay(cap), log: () => {} });
    const stop = channel.start();

    publishEvent(msg('during-gap'));
    await settle();
    expect(cap.contents).not.toContain('during-gap');

    channel.replayMissed();
    await settle();
    stop();

    expect(cap.contents).toContain('during-gap');
  });

  test('a delivery failure is logged, not silently swallowed', async () => {
    const logs: unknown[][] = [];
    const cap: Capture = { contents: [], fail: new Set(['boom']) };
    const channel = new ChannelRelay({
      relay: makeRelay(cap),
      log: (...a: unknown[]) => logs.push(a),
    });
    const stop = channel.start();

    publishEvent(msg('boom'));
    await settle();
    stop();

    expect(logs.some((l) => String(l[0]).includes('channel delivery failed'))).toBe(
      true,
    );
  });

  test('replay bypasses dedup so a reconnecting client still receives the event', async () => {
    const cap: Capture = { contents: [], fail: new Set(['only-once']) };
    const relay = makeRelay(cap);
    const channel = new ChannelRelay({ relay, log: () => {} });
    const stop = channel.start();

    publishEvent(msg('only-once'));
    await settle();
    channel.replayMissed();
    await settle();
    stop();

    expect(cap.contents.filter((c) => c === 'only-once').length).toBe(1);
  });
});
