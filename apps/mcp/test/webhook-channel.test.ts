import { beforeEach, describe, expect, test } from 'bun:test';
import { InboundRelay } from '../src/channels/inbound.ts';
import { buildWebhookNote } from '../src/channels/webhook-note.ts';
import { makeEmit } from '../src/daemon/http.ts';
import { subscribeEvents, type MetroEvent } from '../src/daemon/events.ts';
import { webhookEntry } from '@metro-labs/webhook';

const LINE = 'metro://webhook/a1-gh';

interface Sent {
  method: string;
  params: { content?: string; meta?: Record<string, unknown> };
}

function relayWith(stations: string[]): { sent: Sent[]; relay: InboundRelay } {
  const sent: Sent[] = [];
  const relay = new InboundRelay({
    mcp: {
      notification: (n: Sent) => {
        sent.push(n);
        return Promise.resolve();
      },
    } as never,
    log: () => undefined,
    getStations: () => new Set(stations),
    senderAllowed: () => true,
  });
  return { sent, relay };
}

const hookEvent = (
  headers: Record<string, string>,
  body: unknown,
  id = 'a1-gh',
): Record<string, unknown> => {
  const captured: MetroEvent[] = [];
  const stop = subscribeEvents((e) => captured.push(e));
  makeEmit()(
    webhookEntry(
      { id, label: 'github', createdAt: '' },
      headers,
      body,
      'POST',
      `/wh/${id}`,
    ),
  );
  stop();
  return captured[captured.length - 1] as unknown as Record<string, unknown>;
};

const chatEvent = (line: string, text: string): Record<string, unknown> => ({
  event: { type: 'msg' },
  station: 'discord',
  line,
  from: `${line}/someone`,
  text,
  messageId: `m-${text}`,
});

describe('a webhook delivery reaches the agent', () => {
  let harness: { sent: Sent[]; relay: InboundRelay };

  beforeEach(() => {
    harness = relayWith(['discord', 'webhook']);
  });

  test('the note carries the payload, not just the summary line', async () => {
    await harness.relay.handleEvent(
      hookEvent({ 'x-github-event': 'push', 'x-github-delivery': 'd-1' }, {
        ref: 'refs/heads/main',
      }),
    );
    expect(harness.sent).toHaveLength(1);
    const content = harness.sent[0]?.params.content ?? '';
    expect(content).toContain('[webhook received]');
    expect(content).toContain('github');
    expect(content).toContain('refs/heads/main');
    expect(content).toContain('x-github-delivery: d-1');
    expect(harness.sent[0]?.params.meta).toMatchObject({
      line: LINE,
      station: 'webhook',
      message_id: 'd-1',
    });
  });

  test('a station the channel does not serve is still dropped', async () => {
    const only = relayWith(['discord']);
    await only.relay.handleEvent(hookEvent({ 'x-github-event': 'push' }, {}));
    expect(only.sent).toHaveLength(0);
  });

  test('the same delivery twice is relayed once', async () => {
    const ev = hookEvent({ 'x-github-delivery': 'd-2' }, { a: 1 });
    await harness.relay.handleEvent(ev);
    await harness.relay.handleEvent(ev);
    expect(harness.sent).toHaveLength(1);
  });

  test('a webhook never becomes the line a permission prompt replies to', async () => {
    await harness.relay.handleEvent(
      chatEvent('metro://discord/d1/99', 'a real conversation'),
    );
    expect(harness.relay.knownLine).toBe('metro://discord/d1/99');
    await harness.relay.handleEvent(hookEvent({ 'x-github-event': 'push' }, {}));
    expect(harness.relay.knownLine).toBe('metro://discord/d1/99');
  });

  test('a webhook body is never taken for a permission reply', async () => {
    await harness.relay.handleEvent(
      hookEvent({ 'x-github-event': 'push' }, { text: 'yes abcde' }),
    );
    expect(harness.sent).toHaveLength(1);
  });
});

describe('the note the agent is handed', () => {
  test('only known-safe headers are echoed, never a delivery credential', () => {
    const note = buildWebhookNote('push POST /wh/a1-gh', 'github', {
      headers: {
        'x-github-event': 'push',
        authorization: 'Bearer super-secret-token',
        'x-hub-signature-256': 'sha256=deadbeef',
        cookie: 'session=nope',
      },
      body: {},
    });
    expect(note).toContain('x-github-event: push');
    expect(note).not.toContain('super-secret-token');
    expect(note).not.toContain('deadbeef');
    expect(note).not.toContain('session=nope');
  });

  test('a huge body is truncated with the dropped size named', () => {
    const note = buildWebhookNote('event POST /wh/x', undefined, {
      body: { blob: 'z'.repeat(20_000) },
    });
    expect(note.length).toBeLessThan(9_000);
    expect(note).toMatch(/\[truncated: \d+ more characters\]/);
  });

  test('a body that is plain text is passed through as text', () => {
    const note = buildWebhookNote('event POST /wh/x', undefined, {
      body: 'ping from a provider that does not send json',
    });
    expect(note).toContain('ping from a provider that does not send json');
  });

  test('no body at all still says what arrived', () => {
    const note = buildWebhookNote('event POST /wh/x', 'plain', {});
    expect(note).toContain('[webhook received] plain: event POST /wh/x');
    expect(note).toContain('Inbound only');
  });

  test('the agent is told it cannot answer on this line', () => {
    expect(buildWebhookNote('e', undefined, { body: {} })).toContain(
      'takes no send, reply or react',
    );
  });
});
