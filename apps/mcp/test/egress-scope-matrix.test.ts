/**
 * Every way an inbound event can reach a client, held to ONE invariant.
 *
 * #127 gated `ChannelRelay.deliver()` and shipped, but SSE resumption is a
 * separate egress that never consults the relay — so the gate was real and the
 * leak survived it (prod v146). The point of this file is that the egress list
 * and the case table are written once and crossed: a new path that forgets to
 * scope fails here the moment it is added to EGRESS, and a path nobody adds is
 * visible as a missing row rather than as an absent one-off test.
 *
 * Invariant, for every path and every reader: the reader receives the frame if
 * and only if `eventInScope(readerScope, line)` is true.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { AddressInfo } from 'node:net';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { ChannelRelay } from '../src/channels/relay.ts';
import { InboundRelay } from '../src/channels/inbound.ts';
import { ChannelOwner } from '../src/mcp/channel-owner.ts';
import { BoundedEventStore } from '../src/mcp/event-store.ts';
import { serveStandaloneGet } from '../src/mcp/raw-get-stream.ts';
import type { RequestIdentity } from '../src/mcp/request-identity.ts';
import { makeEmit, startWebhookServer } from '../src/daemon/http.ts';
import { publishEvent, type MetroEvent } from '../src/daemon/events.ts';
import { eventInScope } from '../src/db/agent-scope.ts';
import { setAgentMap } from '../src/db/agent-map.ts';
import { setKeyMap } from '../src/db/key-map.ts';
import { asLine } from '../src/stations/lines.ts';

const STREAM = '_GET_stream';

const TONY_LINE = 'metro://whatsapp/m1-tony/111@lid';
const LISA_LINE = 'metro://whatsapp/m34-lisa/222@lid';
const MO_LINE = 'metro://whatsapp/m7-mo/333@lid';
const GHOST_LINE = 'metro://whatsapp/m99-ghost/444@lid';
const TONY_HOOK = 'metro://webhook/a1-gh';
const LISA_HOOK = 'metro://webhook/a34-gh';
const GHOST_HOOK = 'metro://webhook/nobody-gh';

const TONY_KEY = 'mk_matrix_tony';
const LISA_KEY = 'mk_matrix_lisa';
const PARKED_AGENT = 999;

interface Reader {
  label: string;
  scope: Set<number>;
  token: string | undefined;
}

const TONY: Reader = { label: 'agent 1', scope: new Set([1]), token: TONY_KEY };
const LISA: Reader = {
  label: 'agent 34',
  scope: new Set([34]),
  token: LISA_KEY,
};
const NOBODY: Reader = { label: 'no identity', scope: new Set(), token: undefined };

interface Case {
  name: string;
  reader: Reader;
  line: string;
  delivered: boolean;
}

const CASES: Case[] = [
  { name: 'its own account', reader: TONY, line: TONY_LINE, delivered: true },
  { name: 'another agent account', reader: TONY, line: LISA_LINE, delivered: false },
  { name: 'a third agent account', reader: TONY, line: MO_LINE, delivered: false },
  {
    name: 'an account with no owning agent',
    reader: TONY,
    line: GHOST_LINE,
    delivered: false,
  },
  {
    name: 'the other agent own account',
    reader: LISA,
    line: LISA_LINE,
    delivered: true,
  },
  {
    name: 'the first agent account',
    reader: LISA,
    line: TONY_LINE,
    delivered: false,
  },
  { name: 'any account at all', reader: NOBODY, line: TONY_LINE, delivered: false },
  { name: 'its own webhook', reader: TONY, line: TONY_HOOK, delivered: true },
  {
    name: 'another agent webhook',
    reader: TONY,
    line: LISA_HOOK,
    delivered: false,
  },
  {
    name: 'a webhook with no owning agent',
    reader: TONY,
    line: GHOST_HOOK,
    delivered: false,
  },
  { name: 'any webhook at all', reader: NOBODY, line: TONY_HOOK, delivered: false },
];

let priorStations: string | undefined;
let server: Server | undefined;
let monitorBase = '';

beforeAll(async () => {
  priorStations = process.env.METRO_CHANNEL_STATIONS;
  process.env.METRO_CHANNEL_STATIONS = 'whatsapp,webhook';
  setAgentMap(
    {
      'whatsapp/m1-tony': 1,
      'whatsapp/m34-lisa': 34,
      'whatsapp/m7-mo': 7,
      'webhook/a1-gh': 1,
      'webhook/a34-gh': 34,
    },
    { 1: 'Tony', 34: 'Lisa', 7: 'Mo' },
  );
  setKeyMap([
    { key: TONY_KEY, agentId: 1 },
    { key: LISA_KEY, agentId: 34 },
  ]);
  process.env.METRO_WEBHOOK_PORT = String(
    24000 + Math.floor(Math.random() * 12000),
  );
  process.env.METRO_HTTP_HOST = '127.0.0.1';
  server = await startWebhookServer(makeEmit(), undefined, () =>
    Promise.resolve({ result: null }),
  );
  monitorBase = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  if (priorStations === undefined) delete process.env.METRO_CHANNEL_STATIONS;
  else process.env.METRO_CHANNEL_STATIONS = priorStations;
  setAgentMap({}, {});
  setKeyMap([]);
  if (server) await new Promise<void>((r) => server?.close(() => r()));
});

const identityFor = (reader: Reader): RequestIdentity | undefined =>
  reader.scope.size === 0
    ? undefined
    : { kind: 'google', email: `${reader.label}@example.test`, agentIds: [...reader.scope] };

const stationOf = (line: string): string => line.split('/')[2] ?? 'whatsapp';

const inbound = (line: string, text: string): MetroEvent =>
  ({
    id: `id-${randomUUID()}`,
    ts: new Date().toISOString(),
    station: stationOf(line),
    line: asLine(line),
    from: asLine(`${line}/sender`),
    to: asLine(line),
    text,
    messageId: `m-${randomUUID()}`,
    event: { type: 'msg' },
  }) as unknown as MetroEvent;

const OWNER_OF: Record<string, number> = {
  [TONY_LINE]: 1,
  [LISA_LINE]: 34,
  [MO_LINE]: 7,
  [TONY_HOOK]: 1,
  [LISA_HOOK]: 34,
};

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 40));

function channelSession(owner: ChannelOwner): {
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
    log: () => undefined,
    getStations: () => new Set(['whatsapp', 'webhook']),
    senderAllowed: () => true,
  });
  return {
    received,
    channel: new ChannelRelay({ relay, log: () => undefined, inScope: (l) => owner.inScope(l) }),
  };
}

async function liveChannel(reader: Reader, line: string, text: string): Promise<boolean> {
  const owner = new ChannelOwner();
  const { received, channel } = channelSession(owner);
  const stop = channel.start();
  const identity = identityFor(reader);
  if (identity) owner.bindStream(identity);
  publishEvent(inbound(line, text));
  await settle();
  stop();
  return received.includes(text);
}

async function busReplayAfterRebind(
  reader: Reader,
  line: string,
  text: string,
): Promise<boolean> {
  const owner = new ChannelOwner();
  const { received, channel } = channelSession(owner);
  const stop = channel.start();
  owner.bindStream({ kind: 'agent', agentId: PARKED_AGENT });
  publishEvent(inbound(line, text));
  await settle();
  const identity = identityFor(reader);
  if (identity) owner.bindStream(identity);
  else owner.releaseStream();
  channel.replayMissed();
  await settle();
  stop();
  return received.includes(text);
}

const fakeGetReq = (lastEventId: string): IncomingMessage => {
  const e = new EventEmitter() as unknown as IncomingMessage;
  (e as { method?: string }).method = 'GET';
  (e as { headers?: Record<string, string> }).headers = {
    accept: 'text/event-stream',
    'mcp-session-id': 's1',
    'last-event-id': lastEventId,
  };
  return e;
};

const notification = (line: string, content: string): JSONRPCMessage =>
  ({
    jsonrpc: '2.0',
    method: 'notifications/claude/channel',
    params: { content, meta: { line } },
  }) as unknown as JSONRPCMessage;

async function sseResume(reader: Reader, line: string, text: string): Promise<boolean> {
  const owner = new ChannelOwner();
  const store = new BoundedEventStore({ scopeOf: () => owner.scope() });
  owner.bindStream({ kind: 'agent', agentId: PARKED_AGENT });
  const base = await store.storeEvent(STREAM, notification(MO_LINE, 'baseline'));
  const author = OWNER_OF[line] ?? 1;
  owner.bindStream({ kind: 'agent', agentId: author });
  await store.storeEvent(STREAM, notification(line, text));

  const out = new PassThrough();
  let body = '';
  out.on('data', (c: Buffer) => {
    body += c.toString('utf8');
  });
  const res = out as unknown as ServerResponse;
  (res as { writeHead: unknown }).writeHead = () => res;
  (res as { flushHeaders?: () => void }).flushHeaders = () => undefined;
  const req = fakeGetReq(base);
  await serveStandaloneGet({
    transport: {
      _webStandardTransport: {
        sessionId: 's1',
        _initialized: true,
        _streamMapping: new Map<string, unknown>(),
      },
    } as never,
    eventStore: store,
    scope: reader.scope,
    req,
    res,
    log: () => undefined,
    registerSink: () => undefined,
  });
  req.emit('close');
  return body.includes(text);
}

async function monitorTail(reader: Reader, line: string, text: string): Promise<boolean> {
  const ac = new AbortController();
  const url =
    reader.token === undefined
      ? `${monitorBase}/api/tail`
      : `${monitorBase}/api/tail?token=${reader.token}`;
  const res = await fetch(url, { signal: ac.signal });
  if (res.status !== 200) {
    ac.abort();
    return false;
  }
  const reader_ = res.body?.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const pump = (async () => {
    if (!reader_) return;
    try {
      for (;;) {
        const { done, value } = await reader_.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
      }
    } catch {
      // aborted on teardown
    }
  })();
  await settle();
  publishEvent(inbound(line, text));
  const deadline = Date.now() + 1500;
  while (Date.now() < deadline && !buf.includes(text))
    await new Promise((r) => setTimeout(r, 25));
  ac.abort();
  await pump;
  return buf.includes(text);
}

const EGRESS: Record<
  string,
  (reader: Reader, line: string, text: string) => Promise<boolean>
> = {
  'channel live delivery': liveChannel,
  'channel bus replay after rebind': busReplayAfterRebind,
  'SSE resumption from Last-Event-ID': sseResume,
  'monitor tail': monitorTail,
};

describe('every egress applies the same scope predicate', () => {
  test('the case table agrees with eventInScope itself', () => {
    for (const c of CASES)
      expect([c.name, eventInScope(c.reader.scope, c.line)]).toEqual([
        c.name,
        c.delivered,
      ]);
  });

  test('the matrix covers every place eventInScope is consulted', () => {
    expect(Object.keys(EGRESS).sort()).toEqual([
      'SSE resumption from Last-Event-ID',
      'channel bus replay after rebind',
      'channel live delivery',
      'monitor tail',
    ]);
  });

  for (const [path, run] of Object.entries(EGRESS)) {
    for (const c of CASES) {
      const verb = c.delivered ? 'delivered' : 'withheld';
      test(
        `${path}: ${c.reader.label} and ${c.name} -> ${verb}`,
        async () => {
          const text = `probe-${randomUUID()}`;
          expect(await run(c.reader, c.line, text)).toBe(c.delivered);
        },
        15000,
      );
    }
  }
});
