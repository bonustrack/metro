/**
 * Every way an inbound event can reach a client, held to ONE invariant. The
 * egress list and the case table are written once and crossed: a new path that
 * forgets the gate fails here the moment it is added to EGRESS.
 *
 * Invariant, for every path and every reader: the reader receives the frame if
 * and only if `eventInScope(readerScope, line)` is true.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { ChannelRelay } from '../src/channels/relay.ts';
import { makeRelay, type Notif } from './relay-fixture.ts';
import { settle } from './wait.ts';
import { BoundedEventStore } from '../src/mcp/event-store.ts';
import { serveStandaloneGet } from '../src/mcp/raw-get-stream.ts';
import { bootDaemon, type Daemon } from './http-harness.ts';
import { publishEvent, type MetroEvent } from '@metro-labs/core/events';
import { eventInScope } from '../src/agents/scope.ts';
import { setAgentMap } from '../src/agents/map.ts';
import { setKeyMap } from '../src/agents/keys.ts';
import { asLine } from '@metro-labs/core/lines';

const STREAM = '_GET_stream';

const TONY_LINE = 'metro://whatsapp/m1-tony/111@lid';
const GHOST_LINE = 'metro://whatsapp/m99-ghost/444@lid';
const TONY_HOOK = 'metro://webhook/a1-gh';
const GHOST_HOOK = 'metro://webhook/nobody-gh';

const TONY_KEY = 'mk_matrix_tony';

interface Reader {
  label: string;
  scope: Set<string>;
  token: string | undefined;
}

const TONY: Reader = { label: 'agent 1', scope: new Set(['agent000001']), token: TONY_KEY };
const NOBODY: Reader = { label: 'no identity', scope: new Set(), token: undefined };

interface Case {
  name: string;
  reader: Reader;
  line: string;
  delivered: boolean;
}

const CASES: Case[] = [
  { name: 'its own account', reader: TONY, line: TONY_LINE, delivered: true },
  {
    name: 'an account with no owning agent',
    reader: TONY,
    line: GHOST_LINE,
    delivered: false,
  },
  { name: 'any account at all', reader: NOBODY, line: TONY_LINE, delivered: false },
  { name: 'its own webhook', reader: TONY, line: TONY_HOOK, delivered: true },
  {
    name: 'a webhook with no owning agent',
    reader: TONY,
    line: GHOST_HOOK,
    delivered: false,
  },
  { name: 'any webhook at all', reader: NOBODY, line: TONY_HOOK, delivered: false },
];

let daemon: Daemon | undefined;
let monitorBase = '';

beforeAll(async () => {
  setAgentMap(
    { 'whatsapp/m1-tony': 'agent000001', 'webhook/a1-gh': 'agent000001' },
    { ['agent000001']: 'Tony' },
  );
  setKeyMap([{ key: TONY_KEY, agentId: 'agent000001' }]);
  daemon = await bootDaemon({}, { monitor: true });
  monitorBase = daemon.base;
});

afterAll(async () => {
  setAgentMap({}, {});
  setKeyMap([]);
  if (daemon) await daemon.close();
});

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

interface Stream {
  attached: boolean;
  scope: Set<string>;
}

function channelSession(stream: Stream): {
  notifs: Notif[];
  channel: ChannelRelay;
} {
  const { relay, notifs } = makeRelay(['whatsapp', 'webhook']);
  return {
    notifs,
    channel: new ChannelRelay({
      relay,
      log: () => undefined,
      inScope: (l) => stream.attached && eventInScope(stream.scope, l),
    }),
  };
}

async function liveChannel(reader: Reader, line: string, text: string): Promise<boolean> {
  const stream = { attached: reader.token !== undefined, scope: reader.scope };
  const { notifs, channel } = channelSession(stream);
  const stop = channel.start();
  publishEvent(inbound(line, text));
  await settle(40);
  stop();
  return notifs.some((n) => n.params.content === text);
}

async function busReplayAfterReconnect(
  reader: Reader,
  line: string,
  text: string,
): Promise<boolean> {
  const stream = { attached: false, scope: reader.scope };
  const { notifs, channel } = channelSession(stream);
  const stop = channel.start();
  publishEvent(inbound(line, text));
  await settle(40);
  stream.attached = reader.token !== undefined;
  channel.replayMissed();
  await settle(40);
  stop();
  return notifs.some((n) => n.params.content === text);
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
  const store = new BoundedEventStore();
  const base = await store.storeEvent(STREAM, notification(TONY_LINE, 'baseline'));
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
  await settle(40);
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
  'channel bus replay after reconnect': busReplayAfterReconnect,
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
      'channel bus replay after reconnect',
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
