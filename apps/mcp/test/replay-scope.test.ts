/**
 * SSE resumption is a second egress. `serveStandaloneGet` writes buffered frames
 * straight to whoever reconnects with a Last-Event-ID, before the sink is bound
 * and without ever consulting ChannelRelay — which is exactly how #127's gate
 * was bypassed in prod (v146). These drive that function, not the relay.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { serveStandaloneGet } from '../src/mcp/raw-get-stream.ts';
import { BoundedEventStore } from '../src/mcp/event-store.ts';
import { ChannelOwner } from '../src/mcp/channel-owner.ts';
import { allowedAgents } from '../src/mcp/request-identity.ts';
import type { RequestIdentity } from '../src/mcp/request-identity.ts';
import { setAgentMap } from '../src/db/agent-map.ts';

const STREAM = '_GET_stream';

const TONY: RequestIdentity = { kind: 'agent', agentId: 'agent000001' };
const LISA: RequestIdentity = { kind: 'agent', agentId: 'agent000034' };
const MO: RequestIdentity = { kind: 'agent', agentId: 'agent000007' };
const TONY_OWNER: RequestIdentity = {
  kind: 'session',
  subject: 'tony@example.test',
  agentIds: ['agent000001'],
};

const TONY_LINE = 'metro://whatsapp/a1-tony/111@lid';
const LISA_LINE = 'metro://whatsapp/a34-lisa/222@lid';
const MO_LINE = 'metro://whatsapp/a7-mo/333@lid';

beforeAll(() =>
  setAgentMap(
    {
      'whatsapp/a1-tony': 'agent000001',
      'whatsapp/a34-lisa': 'agent000034',
      'whatsapp/a7-mo': 'agent000007',
    },
    { ['agent000001']: 'Tony', ['agent000034']: 'Lisa', 7: 'Mo' },
  ),
);
afterAll(() => setAgentMap({}, {}));

const frame = (content: string, line: string): JSONRPCMessage =>
  ({
    jsonrpc: '2.0',
    method: 'notifications/claude/channel',
    params: { content, meta: { line, from: `${line}/sender` } },
  }) as unknown as JSONRPCMessage;

const fakeTransport = (): { _webStandardTransport: object } => ({
  _webStandardTransport: {
    sessionId: 's1',
    _initialized: true,
    _streamMapping: new Map<string, unknown>(),
  },
});

const fakeReq = (lastEventId?: string): IncomingMessage => {
  const e = new EventEmitter() as unknown as IncomingMessage;
  (e as { method?: string }).method = 'GET';
  (e as { headers?: Record<string, string> }).headers = {
    accept: 'text/event-stream',
    'mcp-session-id': 's1',
    ...(lastEventId === undefined ? {} : { 'last-event-id': lastEventId }),
  };
  return e;
};

const newStore = (owner: ChannelOwner): BoundedEventStore =>
  new BoundedEventStore({ scopeOf: () => owner.scope() });

async function reconnect(
  store: BoundedEventStore,
  identity: RequestIdentity | undefined,
  lastEventId: string | undefined,
): Promise<string> {
  const out = new PassThrough();
  let body = '';
  out.on('data', (c: Buffer) => {
    body += c.toString('utf8');
  });
  const res = out as unknown as ServerResponse;
  (res as { writeHead: unknown }).writeHead = () => res;
  (res as { flushHeaders?: () => void }).flushHeaders = () => undefined;
  const req = fakeReq(lastEventId);
  await serveStandaloneGet({
    transport: fakeTransport() as never,
    eventStore: store,
    scope: allowedAgents(identity),
    req,
    res,
    log: () => undefined,
    registerSink: () => undefined,
  });
  req.emit('close');
  return body;
}

describe('SSE replay is scoped to the reconnecting identity', () => {
  test('a Last-Event-ID spanning both agents replays only the reader own frames', async () => {
    const owner = new ChannelOwner();
    const store = newStore(owner);

    owner.bindStream(TONY);
    const base = await store.storeEvent(STREAM, frame('tony one', TONY_LINE));
    owner.bindStream(LISA);
    await store.storeEvent(STREAM, frame('lisa secret', LISA_LINE));
    owner.bindStream(TONY);
    await store.storeEvent(STREAM, frame('tony two', TONY_LINE));

    const tony = await reconnect(store, TONY, base);
    expect(tony).toContain('tony two');
    expect(tony).not.toContain('lisa secret');

    const lisa = await reconnect(store, LISA, base);
    expect(lisa).toContain('lisa secret');
    expect(lisa).not.toContain('tony two');
  });

  test('the withheld frame still reaches its rightful owner afterwards', async () => {
    const owner = new ChannelOwner();
    const store = newStore(owner);

    owner.bindStream(TONY);
    const base = await store.storeEvent(STREAM, frame('tony one', TONY_LINE));
    owner.bindStream(LISA);
    await store.storeEvent(STREAM, frame('lisa secret', LISA_LINE));

    expect(await reconnect(store, TONY, base)).not.toContain('lisa secret');
    expect(await reconnect(store, TONY, base)).not.toContain('lisa secret');
    expect(await reconnect(store, LISA, base)).toContain('lisa secret');
  });

  test('a third agent frames sitting in the gap reach neither side', async () => {
    const owner = new ChannelOwner();
    const store = newStore(owner);

    owner.bindStream(TONY);
    const base = await store.storeEvent(STREAM, frame('tony one', TONY_LINE));
    owner.bindStream(MO);
    await store.storeEvent(STREAM, frame('mo private', MO_LINE));
    owner.bindStream(LISA);
    await store.storeEvent(STREAM, frame('lisa secret', LISA_LINE));

    const tony = await reconnect(store, TONY, base);
    expect(tony).not.toContain('mo private');
    expect(tony).not.toContain('lisa secret');

    const lisa = await reconnect(store, LISA, base);
    expect(lisa).not.toContain('mo private');
    expect(lisa).toContain('lisa secret');

    expect(await reconnect(store, MO, base)).toContain('mo private');
  });

  test('a Last-Event-ID older than the whole buffer replays nothing', async () => {
    const owner = new ChannelOwner();
    const store = new BoundedEventStore({
      scopeOf: () => owner.scope(),
      max: 3,
    });
    owner.bindStream(TONY);
    const evicted = await store.storeEvent(
      STREAM,
      frame('evicted', TONY_LINE),
    );
    for (let i = 0; i < 4; i++)
      await store.storeEvent(STREAM, frame(`kept ${i}`, TONY_LINE));
    owner.bindStream(LISA);
    await store.storeEvent(STREAM, frame('lisa secret', LISA_LINE));

    const body = await reconnect(store, TONY, evicted);
    expect(body).not.toContain('kept');
    expect(body).not.toContain('lisa secret');
  });

  test('a Last-Event-ID newer than every frame replays nothing', async () => {
    const owner = new ChannelOwner();
    const store = newStore(owner);
    owner.bindStream(LISA);
    await store.storeEvent(STREAM, frame('lisa secret', LISA_LINE));

    const body = await reconnect(store, TONY, `${STREAM}_9999`);
    expect(body).not.toContain('lisa secret');
  });

  test('a malformed, unknown or forged Last-Event-ID never opens the buffer', async () => {
    const owner = new ChannelOwner();
    const store = newStore(owner);
    owner.bindStream(LISA);
    await store.storeEvent(STREAM, frame('lisa first', LISA_LINE));
    await store.storeEvent(STREAM, frame('lisa secret', LISA_LINE));

    for (const forged of [
      'garbage',
      '_',
      `${STREAM}_`,
      `${STREAM}_-1`,
      `${STREAM}_1.5`,
      'other_1',
      '../_GET_stream_1',
    ]) {
      const body = await reconnect(store, TONY, forged);
      expect(body).not.toContain('lisa secret');
      expect(body).not.toContain('lisa first');
    }
  });

  test('a forged Last-Event-ID guessed correctly still yields nothing out of scope', async () => {
    const owner = new ChannelOwner();
    const store = newStore(owner);
    owner.bindStream(LISA);
    const real = await store.storeEvent(STREAM, frame('lisa first', LISA_LINE));
    await store.storeEvent(STREAM, frame('lisa secret', LISA_LINE));

    expect(real).toBe(`${STREAM}_1`);
    const body = await reconnect(store, TONY, `${STREAM}_1`);
    expect(body).not.toContain('lisa secret');
  });

  test('an unauthenticated reconnect replays nothing', async () => {
    const owner = new ChannelOwner();
    const store = newStore(owner);
    owner.bindStream(TONY);
    const base = await store.storeEvent(STREAM, frame('tony one', TONY_LINE));
    await store.storeEvent(STREAM, frame('tony two', TONY_LINE));

    const body = await reconnect(store, undefined, base);
    expect(body).not.toContain('tony two');
  });

  test('a google session scoped to one agent resumes only that agent', async () => {
    const owner = new ChannelOwner();
    const store = newStore(owner);

    owner.bindStream(TONY_OWNER);
    const base = await store.storeEvent(STREAM, frame('tony one', TONY_LINE));
    owner.bindStream(LISA);
    await store.storeEvent(STREAM, frame('lisa secret', LISA_LINE));
    owner.bindStream(TONY_OWNER);
    await store.storeEvent(STREAM, frame('tony two', TONY_LINE));

    const body = await reconnect(store, TONY_OWNER, base);
    expect(body).toContain('tony two');
    expect(body).not.toContain('lisa secret');
  });

  test('the legitimate same-identity resumption still works', async () => {
    const owner = new ChannelOwner();
    const store = newStore(owner);
    owner.bindStream(TONY);
    const base = await store.storeEvent(STREAM, frame('tony one', TONY_LINE));
    await store.storeEvent(STREAM, frame('tony two', TONY_LINE));
    await store.storeEvent(STREAM, frame('tony three', TONY_LINE));

    const body = await reconnect(store, TONY, base);
    expect(body).not.toContain('tony one');
    expect(body).toContain('tony two');
    expect(body).toContain('tony three');
    expect(body.indexOf('tony two')).toBeLessThan(body.indexOf('tony three'));
    expect(body).toContain(`id: ${STREAM}_2`);
  });

  test('a reconnect with no Last-Event-ID replays nothing and still primes', async () => {
    const owner = new ChannelOwner();
    const store = newStore(owner);
    owner.bindStream(TONY);
    await store.storeEvent(STREAM, frame('tony one', TONY_LINE));

    const body = await reconnect(store, TONY, undefined);
    expect(body).not.toContain('tony one');
    expect(body).toContain('retry: 15000');
  });
});
