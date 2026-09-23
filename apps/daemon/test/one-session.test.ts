/**
 * A box runs one agent, so the daemon holds one MCP session at a time. These
 * pin what that single slot still has to do, over real HTTP against the real
 * `createMetroMcp`: a new initialize supersedes, an unknown id is adopted,
 * a message sent while the agent was away is replayed, and a line whose
 * account maps to no agent is never delivered.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { createMetroMcp } from '../src/mcp/index.ts';
import { setKeyMap } from '../src/agents/keys.ts';
import { setAgentMap } from '../src/agents/map.ts';
import { asLine } from '@metro-labs/core/lines';
import { publishEvent, type MetroEvent } from '@metro-labs/core/events';

const TOKEN = 'mk_one_tony';
const ACCOUNT = 'a1-onetony';
const STRAY_ACCOUNT = 'a9-unmapped';
const LINE = `metro://whatsapp/${ACCOUNT}/111@lid`;
const STRAY_LINE = `metro://whatsapp/${STRAY_ACCOUNT}/222@lid`;

let server: Server | undefined;
let base = '';

const url = (): string => `${base}/mcp?token=${TOKEN}`;

const msg = (line: string, text: string): MetroEvent =>
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

const initSession = async (): Promise<string> => {
  const res = await fetch(url(), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'probe', version: '0.0.0' },
      },
    }),
  });
  const sessionId = res.headers.get('mcp-session-id');
  await res.body?.cancel();
  if (!sessionId) throw new Error('no session id from initialize');
  return sessionId;
};

interface Stream {
  raw: () => string;
  status: number;
  ended: () => boolean;
  stop: () => Promise<void>;
}

const openGet = async (
  sessionId: string,
  lastEventId?: string,
): Promise<Stream> => {
  const ac = new AbortController();
  const headers: Record<string, string> = {
    accept: 'text/event-stream',
    'mcp-session-id': sessionId,
    'mcp-protocol-version': '2025-06-18',
  };
  if (lastEventId !== undefined) headers['last-event-id'] = lastEventId;
  const res = await fetch(url(), {
    method: 'GET',
    signal: ac.signal,
    headers,
  });
  let raw = '';
  let ended = false;
  const reader = res.body?.getReader();
  const decoder = new TextDecoder();
  const pump = (async () => {
    if (!reader) return;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          ended = true;
          break;
        }
        raw += decoder.decode(value, { stream: true });
      }
    } catch {
      // aborted on teardown
    }
  })();
  return {
    raw: () => raw,
    status: res.status,
    ended: () => ended,
    stop: async () => {
      ac.abort();
      await pump;
    },
  };
};

const waitFor = async (predicate: () => boolean, ms = 5000): Promise<void> => {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
};

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 150));

beforeAll(async () => {
  setKeyMap([{ key: TOKEN, agentId: 'agent000001' }]);
  setAgentMap({ [`whatsapp/${ACCOUNT}`]: 'agent000001' }, { ['agent000001']: 'Tony' });
  const handler = await createMetroMcp();
  handler.startInbound();
  server = createServer((req, res) => {
    void handler.httpHandler(req, res);
  });
  await new Promise<void>((r) => server?.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  setKeyMap([]);
  setAgentMap({}, {});
  if (server) await new Promise<void>((r) => server?.close(() => r()));
});

const toolsList = (sessionId?: string): Promise<Response> =>
  fetch(url(), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-06-18',
      ...(sessionId === undefined ? {} : { 'mcp-session-id': sessionId }),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
  });

describe('one session per box', () => {
  test('a second initialize supersedes the first and ends its stream', async () => {
    const first = await initSession();
    const old = await openGet(first);
    await settle();
    const second = await initSession();
    expect(second).not.toBe(first);
    await waitFor(() => old.ended());
    expect(old.ended()).toBe(true);

    const fresh = await openGet(second);
    await settle();
    const text = `after-reinit-${randomUUID()}`;
    publishEvent(msg(LINE, text));
    await waitFor(() => fresh.raw().includes(text));
    expect(fresh.raw()).toContain(text);
    await old.stop();
    await fresh.stop();
  }, 30000);

  test('an unknown session id is adopted, not refused', async () => {
    const stale = randomUUID();
    const res = await toolsList(stale);
    const body = await res.text();
    expect(res.status).toBe(200);
    expect(res.headers.get('mcp-session-id')).toBe(stale);
    expect(body).toContain('"tools"');
  }, 30000);

  test('a line whose account maps to no agent is never delivered', async () => {
    const sessionId = await initSession();
    const stream = await openGet(sessionId);
    await settle();
    const stray = `stray-${randomUUID()}`;
    const mine = `mine-${randomUUID()}`;
    publishEvent(msg(STRAY_LINE, stray));
    publishEvent(msg(LINE, mine));
    await waitFor(() => stream.raw().includes(mine));
    const body = stream.raw();
    await stream.stop();
    expect(body).toContain(mine);
    expect(body).not.toContain(stray);
    expect(body).not.toContain(STRAY_ACCOUNT);
  }, 30000);

  test('a gap message arrives after reconnecting a dropped stream', async () => {
    const sessionId = await initSession();
    const first = await openGet(sessionId);
    await settle();
    await first.stop();
    await settle();

    const gap = `gap-${randomUUID()}`;
    publishEvent(msg(LINE, gap));
    await settle();

    const second = await openGet(sessionId);
    await waitFor(() => second.raw().includes(gap));
    const body = second.raw();
    await second.stop();
    expect(body).toContain(gap);
  }, 30000);

  test('a gap message survives a full re-initialize', async () => {
    const firstSession = await initSession();
    const first = await openGet(firstSession);
    await settle();
    await first.stop();
    await settle();

    const gap = `gap-across-init-${randomUUID()}`;
    publishEvent(msg(LINE, gap));
    await settle();

    const secondSession = await initSession();
    const second = await openGet(secondSession);
    await waitFor(() => second.raw().includes(gap));
    const body = second.raw();
    await second.stop();
    expect(body).toContain(gap);
  }, 30000);
});
