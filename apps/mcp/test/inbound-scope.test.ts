/**
 * Two agents, two owners, one account each. Drives the real inbound path
 * (publishEvent -> bus -> ChannelRelay -> InboundRelay -> notification) with the
 * same `eventInScope` predicate the outbound gate and the Monitor tail use, and
 * asserts an account's traffic only ever reaches the session that owns it.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { ChannelRelay } from '../src/channels/relay.ts';
import { InboundRelay } from '../src/channels/inbound.ts';
import { ChannelOwner } from '../src/mcp/channel-owner.ts';
import { publishEvent, type MetroEvent } from '../src/daemon/events.ts';
import { setAgentMap } from '../src/db/agent-map.ts';
import { asLine } from '../src/stations/lines.ts';
import type { RequestIdentity } from '../src/mcp/request-identity.ts';

const TONY: RequestIdentity = { kind: 'agent', agentId: 1 };
const LISA: RequestIdentity = { kind: 'agent', agentId: 34 };
const TONY_OWNER: RequestIdentity = {
  kind: 'google',
  email: 'tony@example.test',
  agentIds: [1],
};

const TONY_LINE = 'metro://whatsapp/a1-tony/111@lid';
const LISA_LINE = 'metro://whatsapp/a34-lisa/222@lid';

beforeEach(() =>
  setAgentMap(
    { 'whatsapp/a1-tony': 1, 'whatsapp/a34-lisa': 34 },
    { 1: 'Tony', 34: 'Lisa' },
  ),
);
afterAll(() => setAgentMap({}, {}));

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 30));

function makeSession(owner: ChannelOwner): {
  received: string[];
  channel: ChannelRelay;
} {
  const received: string[] = [];
  const relay = new InboundRelay({
    mcp: {
      notification: (n: { params: { content?: string } }) => {
        received.push(n.params.content ?? '');
        return Promise.resolve();
      },
    } as never,
    log: () => {},
    getStations: () => new Set(['whatsapp']),
    senderAllowed: () => true,
  });
  return {
    received,
    channel: new ChannelRelay({
      relay,
      log: () => {},
      inScope: (line) => owner.inScope(line),
    }),
  };
}

const inbound = (line: string, text: string): MetroEvent =>
  ({
    id: `id-${randomUUID()}`,
    ts: new Date().toISOString(),
    station: 'whatsapp',
    line: asLine(line),
    from: asLine(`${line}/sender`),
    to: asLine(line),
    text,
    messageId: `m-${randomUUID()}`,
    event: { type: 'msg' },
  }) as unknown as MetroEvent;

describe('inbound delivery is scoped to the account owner', () => {
  test('each session receives only its own account traffic', async () => {
    const owner = new ChannelOwner();
    const { received, channel } = makeSession(owner);
    const stop = channel.start();

    owner.bindStream(TONY);
    publishEvent(inbound(TONY_LINE, 'hello tony'));
    publishEvent(inbound(LISA_LINE, 'hello lisa'));
    await settle();

    expect(received).toEqual(['hello tony']);

    owner.bindStream(LISA);
    channel.replayMissed();
    await settle();
    stop();

    expect(received).toEqual(['hello tony', 'hello lisa']);
  });

  test('a session holding the transport never receives another agent traffic', async () => {
    const owner = new ChannelOwner();
    const { received, channel } = makeSession(owner);
    const stop = channel.start();

    owner.bindStream(LISA);
    publishEvent(inbound(TONY_LINE, 'tony only'));
    await settle();
    stop();

    expect(received).toEqual([]);
  });

  test('a withheld event is replayed to its owner, not dropped', async () => {
    const owner = new ChannelOwner();
    const { received, channel } = makeSession(owner);
    const stop = channel.start();

    owner.bindStream(LISA);
    publishEvent(inbound(TONY_LINE, 'held for tony'));
    await settle();
    expect(received).toEqual([]);

    owner.bindStream(TONY);
    channel.replayMissed();
    await settle();
    stop();

    expect(received).toEqual(['held for tony']);
  });

  test('an unauthenticated channel receives nothing', async () => {
    const owner = new ChannelOwner();
    const { received, channel } = makeSession(owner);
    const stop = channel.start();

    publishEvent(inbound(TONY_LINE, 'nobody is bound'));
    publishEvent(inbound(LISA_LINE, 'nobody is bound either'));
    await settle();
    stop();

    expect(received).toEqual([]);
  });

  test('a google session scoped to one agent sees only that agent', async () => {
    const owner = new ChannelOwner();
    const { received, channel } = makeSession(owner);
    const stop = channel.start();

    owner.bindStream(TONY_OWNER);
    publishEvent(inbound(LISA_LINE, 'not yours'));
    publishEvent(inbound(TONY_LINE, 'yours'));
    await settle();
    stop();

    expect(received).toEqual(['yours']);
  });
});

describe('ChannelOwner', () => {
  test('the bound stream decides what is in scope', () => {
    const owner = new ChannelOwner();
    owner.bindStream(LISA);
    expect(owner.inScope(TONY_LINE)).toBe(false);
    expect(owner.inScope(LISA_LINE)).toBe(true);
  });

  test('with no stream bound nothing is deliverable', () => {
    const owner = new ChannelOwner();
    expect(owner.inScope(TONY_LINE)).toBe(false);
    expect(owner.inScope('metro://webhook/gh')).toBe(false);
    owner.bindStream(TONY);
    owner.releaseStream();
    expect(owner.inScope(TONY_LINE)).toBe(false);
  });

  test('an open stream is only kept across a rebind by the same session key', () => {
    const owner = new ChannelOwner();
    expect(owner.streamBelongsTo(TONY)).toBe(false);
    owner.bindStream(TONY);
    expect(owner.streamBelongsTo(TONY)).toBe(true);
    expect(owner.streamBelongsTo(TONY_OWNER)).toBe(false);
    expect(owner.streamBelongsTo(LISA)).toBe(false);
  });
});
