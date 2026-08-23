/**
 * Replaces the removed inbound-resume test (PR #29). history.jsonl is gone;
 * inbound delivery is now an in-process push. This asserts the full live path:
 * a dispatcher-emitted event published to the event bus reaches an
 * `InboundRelay` listener and produces the `notifications/claude/channel`
 * MCP notification with the unchanged shape the agent sees.
 */

import { describe, expect, test } from 'bun:test';
import { InboundRelay } from '../src/channels/inbound.ts';
import { publishEvent, subscribeEvents } from '../src/daemon/events.ts';

type Notif = { method: string; params: Record<string, unknown> };

function makeRelay(): { relay: InboundRelay; notifs: Notif[] } {
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
    getStations: () => new Set(['discord-bot']),
    senderAllowed: () => true,
  });
  return { relay, notifs };
}

describe('inbound event bus → InboundRelay', () => {
  test('a published inbound msg produces a claude/channel notification', async () => {
    const { relay, notifs } = makeRelay();
    const stop = subscribeEvents((e) => {
      void relay.handleEvent(e as unknown as Record<string, unknown>);
    });

    publishEvent({
      id: 'msg_bus_1',
      ts: '2026-06-21T00:00:00.000Z',
      station: 'discord-bot',
      line: 'metro://discord-bot/g/1/c/2' as never,
      lineName: 'general',
      from: 'metro://discord-bot/u/alice' as never,
      fromName: 'alice_handle',
      fromDisplayName: 'Alice',
      to: 'metro://discord-bot/g/1/c/2' as never,
      text: 'hello from the bus',
      messageId: 'disc-1',
      event: { type: 'msg' },
    });

    /** handleEvent is async; let the microtask queue drain. */
    await new Promise((r) => setTimeout(r, 50));
    stop();

    const channel = notifs.filter((n) => n.method === 'notifications/claude/channel');
    expect(channel.length).toBe(1);
    expect(channel[0].params.content).toBe('hello from the bus');
    const meta = channel[0].params.meta as Record<string, unknown>;
    expect(meta.line).toBe('metro://discord-bot/g/1/c/2');
    expect(meta.from).toBe('metro://discord-bot/u/alice');
    expect(meta.from_name).toBe('alice_handle');
    expect(meta.from_display_name).toBe('Alice');
    expect(meta.station).toBe('discord-bot');
    expect(meta.message_id).toBe('disc-1');
    expect(meta.ts).toBe('2026-06-21T00:00:00.000Z');
  });

  test('every meta value is a string — a non-string drops the whole notification', async () => {
    const { relay, notifs } = makeRelay();
    const stop = subscribeEvents((e) => {
      void relay.handleEvent(e as unknown as Record<string, unknown>);
    });

    publishEvent({
      id: 'msg_bus_types',
      ts: '2026-06-21T00:00:00.000Z',
      station: 'discord-bot',
      line: 'metro://discord-bot/g/1/c/2' as never,
      lineName: 'general',
      from: 'metro://discord-bot/u/alice' as never,
      fromName: 'alice_handle',
      to: 'metro://discord-bot/g/1/c/2' as never,
      text: 'typed',
      messageId: 'disc-2',
      event: { type: 'msg' },
    });

    await new Promise((r) => setTimeout(r, 50));
    stop();

    const channel = notifs.filter(
      (n) => n.method === 'notifications/claude/channel',
    );
    expect(channel.length).toBe(1);
    const meta = channel[0].params.meta as Record<string, unknown>;
    expect(Object.keys(meta).length).toBeGreaterThan(0);
    for (const [key, value] of Object.entries(meta))
      expect([key, typeof value]).toEqual([key, 'string']);
  });

  test('events from a non-subscribed station are ignored', async () => {
    const { relay, notifs } = makeRelay();
    const stop = subscribeEvents((e) => {
      void relay.handleEvent(e as unknown as Record<string, unknown>);
    });

    publishEvent({
      id: 'msg_bus_2',
      ts: '2026-06-21T00:00:01.000Z',
      station: 'telegram-bot',
      line: 'metro://telegram-bot/-100/1' as never,
      from: 'metro://telegram-bot/u/bob' as never,
      to: 'metro://telegram-bot/-100/1' as never,
      text: 'ignored',
      messageId: 'tg-1',
      event: { type: 'msg' },
    });

    await new Promise((r) => setTimeout(r, 50));
    stop();
    expect(notifs.length).toBe(0);
  });
});
