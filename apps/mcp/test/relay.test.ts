import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { handleRelayRequest, type RelayApiDeps } from '../src/daemon/relay.ts';
import { signAgentToken, signRunToken, signSession } from '../src/daemon/session.ts';
import type { RelayTarget } from '../src/db/connector-relay.ts';
import { ApiError } from '../src/daemon/api-error.ts';

const SECRET = 'relay-test-secret';
const EMAIL = 'less@bonustrack.co';
const AGENT = 'agent000001';
const CONN = 'conn0000001';

interface Seen {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

const seen: Seen[] = [];
let vendorAccepts = 'v-live';
let upstreamAborted = false;

let upstream: Server;
let upBase = '';
let relay: Server;
let base = '';

type Mode = 'ok' | 'signin' | 'flip' | 'dead' | 'redirect';
let mode: Mode = 'ok';
let forceCalls = 0;

const deps: RelayApiDeps = {
  target: (agentId, connectorId, force): Promise<RelayTarget> => {
    if (agentId !== AGENT || connectorId !== CONN)
      return Promise.resolve({ kind: 'missing' });
    if (force) forceCalls += 1;
    if (mode === 'signin') return Promise.resolve({ kind: 'signin' });
    if (mode === 'redirect')
      return Promise.resolve({ kind: 'ok', url: `${upBase}/redirect`, headers: {} });
    const stale = mode === 'flip' || mode === 'dead';
    const vendor = stale && !(mode === 'flip' && force) ? 'v-old' : 'v-live';
    return Promise.resolve({
      kind: 'ok',
      url: `${upBase}/mcp`,
      headers: { 'x-vendor': vendor },
    });
  },
  fence: (runtimeId) =>
    runtimeId === 'rt1'
      ? Promise.resolve()
      : Promise.reject(new ApiError('this runtime no longer holds the agent', 409)),
};

async function bodyOf(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function serveMcp(req: IncomingMessage, res: ServerResponse, body: string): void {
  if (req.headers['x-vendor'] !== vendorAccepts) {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end('{"error":"upstream says no"}');
    return;
  }
  if (req.method === 'DELETE') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"closed":true}');
    return;
  }
  if (req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('id: 1\nevent: message\ndata: {"n":1}\n\n');
    return;
  }
  if (body.includes('"initialize"')) {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'mcp-session-id': 'up-sess-1',
    });
    res.write('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n\n');
    res.end();
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      result: { session: req.headers['mcp-session-id'] ?? null },
    }),
  );
}

beforeAll(async () => {
  process.env.METRO_SESSION_SECRET = SECRET;
  process.env.METRO_RELAY_KEEPALIVE_MS = '60';
  upstream = createServer((req, res) => {
    if (req.method === 'GET')
      req.socket.once('close', () => {
        upstreamAborted = true;
      });
    bodyOf(req)
      .then((body) => {
        seen.push({
          method: req.method ?? '',
          path: req.url ?? '',
          headers: req.headers,
          body,
        });
        if (req.url === '/redirect') {
          res.writeHead(302, { location: 'https://evil.example/steal' });
          res.end();
          return;
        }
        serveMcp(req, res, body);
      })
      .catch(() => {
        res.writeHead(500).end();
      });
  });
  relay = createServer((req, res) => {
    if (handleRelayRequest(req, res, deps)) return;
    res.writeHead(404).end();
  });
  await new Promise<void>((done) => {
    upstream.listen(0, '127.0.0.1', done);
  });
  await new Promise<void>((done) => {
    relay.listen(0, '127.0.0.1', done);
  });
  upBase = `http://127.0.0.1:${String((upstream.address() as AddressInfo).port)}`;
  base = `http://127.0.0.1:${String((relay.address() as AddressInfo).port)}`;
});

afterAll(() => {
  upstream.close();
  relay.close();
  delete process.env.METRO_SESSION_SECRET;
  delete process.env.METRO_RELAY_KEEPALIVE_MS;
});

beforeEach(() => {
  seen.length = 0;
  mode = 'ok';
  forceCalls = 0;
  vendorAccepts = 'v-live';
  upstreamAborted = false;
});

const cliToken = (agent = AGENT): string =>
  signAgentToken({ email: EMAIL, agentId: agent }, SECRET);
const runToken = (agent = AGENT): string =>
  signRunToken({ email: EMAIL, agentId: agent, runtimeId: 'rt1' }, SECRET);

const call = (
  path: string,
  init: RequestInit = {},
  token: string | null = cliToken(),
): Promise<Response> =>
  fetch(`${base}${path}`, {
    ...init,
    headers: {
      ...(init.headers as Record<string, string> | undefined),
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    },
  });

const post = (body: unknown, headers: Record<string, string> = {}): Promise<Response> =>
  call(`/relay/${CONN}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

const INIT = { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} };

describe('who may speak to a relay', () => {
  test('no token, a session JWT, and garbage are all 401', async () => {
    expect((await call(`/relay/${CONN}`, { method: 'POST' }, null)).status).toBe(401);
    const jwt = signSession({ email: EMAIL, agentIds: [] }, SECRET);
    expect((await call(`/relay/${CONN}`, { method: 'POST' }, jwt)).status).toBe(401);
    expect((await call(`/relay/${CONN}`, { method: 'POST' }, 'junk')).status).toBe(401);
    expect(seen).toHaveLength(0);
  });

  test('a connector the agent does not hold is a flat 404', async () => {
    const other = cliToken('agent000002');
    const res = await call(`/relay/${CONN}`, { method: 'POST' }, other);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'no such connector' });
    expect(seen).toHaveLength(0);
  });

  test('a run token whose lease was taken back is 401, before any upstream contact', async () => {
    const stale = signRunToken({ email: EMAIL, agentId: AGENT, runtimeId: 'rt0' }, SECRET);
    const res = await call(`/relay/${CONN}`, { method: 'DELETE' }, stale);
    expect(res.status).toBe(401);
    expect(seen).toHaveLength(0);
  });

  test('a run token speaks for its agent too, and only its agent', async () => {
    const res = await call(`/relay/${CONN}`, { method: 'DELETE' }, runToken());
    expect(res.status).toBe(200);
    const other = await call(`/relay/${CONN}`, { method: 'DELETE' }, runToken('agent000002'));
    expect(other.status).toBe(404);
    expect(seen).toHaveLength(1);
  });

  test('a malformed id and a bare /relay are 404, a wrong method 405', async () => {
    expect((await call('/relay/short', { method: 'POST' })).status).toBe(404);
    expect((await call('/relay', { method: 'POST' })).status).toBe(404);
    expect((await call(`/relay/${CONN}`, { method: 'PUT' })).status).toBe(405);
  });
});

describe('what the upstream sees', () => {
  test('the vendor credential is injected and the agent token never travels', async () => {
    const res = await post(INIT, { 'mcp-protocol-version': '2025-06-18' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(res.headers.get('mcp-session-id')).toBe('up-sess-1');
    expect(await res.text()).toContain('"ok":true');
    const [hit] = seen;
    expect(hit?.headers['x-vendor']).toBe('v-live');
    expect(hit?.headers.authorization).toBeUndefined();
    expect(hit?.headers['mcp-protocol-version']).toBe('2025-06-18');
  });

  test('the session id rides through in both directions', async () => {
    const res = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, {
      'mcp-session-id': 'up-sess-1',
    });
    const body = (await res.json()) as { result: { session: string } };
    expect(body.result.session).toBe('up-sess-1');
    expect(seen[0]?.headers['mcp-session-id']).toBe('up-sess-1');
  });

  test('DELETE terminates the upstream session', async () => {
    const res = await call(`/relay/${CONN}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ closed: true });
    expect(seen[0]?.method).toBe('DELETE');
  });
});

describe('upstream auth failures', () => {
  test('a 401 forces one refresh and the retry succeeds invisibly', async () => {
    mode = 'flip';
    const res = await post(INIT);
    expect(res.status).toBe(200);
    expect(forceCalls).toBe(1);
    expect(seen).toHaveLength(2);
    expect(seen[0]?.headers['x-vendor']).toBe('v-old');
    expect(seen[1]?.headers['x-vendor']).toBe('v-live');
  });

  test('a 401 that survives the refresh is 424 with the fix named', async () => {
    mode = 'dead';
    const res = await post(INIT);
    expect(res.status).toBe(424);
    const body = (await res.json()) as { error: string; reconnect: string };
    expect(body.error).toContain('signing in');
    expect(body.reconnect).toContain(CONN);
    expect(forceCalls).toBe(1);
  });

  test('a signed-out connector is 424 before any upstream contact', async () => {
    mode = 'signin';
    const res = await post(INIT);
    expect(res.status).toBe(424);
    expect(seen).toHaveLength(0);
  });
});

describe('hostile or oversized traffic', () => {
  test('an upstream redirect is refused, never followed', async () => {
    mode = 'redirect';
    const res = await post(INIT);
    expect(res.status).toBe(502);
    expect((await res.text())).not.toContain('evil.example');
  });

  test('a body over the cap is refused as 413', async () => {
    const big = Buffer.alloc(9 * 1024 * 1024, 65);
    const res = await call(`/relay/${CONN}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: big,
    });
    expect(res.status).toBe(413);
    expect(seen).toHaveLength(0);
  });
});

describe('the standalone GET stream', () => {
  test('events pipe through, quiet stretches carry keepalives, an abort propagates', async () => {
    const control = new AbortController();
    const res = await call(`/relay/${CONN}`, {
      method: 'GET',
      headers: { accept: 'text/event-stream' },
      signal: control.signal,
    });
    expect(res.status).toBe(200);
    const reader = res.body?.getReader();
    if (reader === undefined) throw new Error('no stream');
    const decoder = new TextDecoder();
    let text = '';
    while (!text.includes('"n":1')) {
      const { value } = await reader.read();
      text += decoder.decode(value, { stream: true });
    }
    expect(text).toContain('id: 1');
    while (!text.includes(': keepalive')) {
      const { value } = await reader.read();
      text += decoder.decode(value, { stream: true });
    }
    control.abort();
    const until = Date.now() + 3_000;
    while (!upstreamAborted && Date.now() < until)
      await new Promise((r) => setTimeout(r, 20));
    expect(upstreamAborted).toBe(true);
  });
});
