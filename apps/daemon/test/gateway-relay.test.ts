import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomInt } from 'node:crypto';
import { gatewayUrl, handleGatewayRelay, type RelayDeps } from '../src/gateway/relay.ts';

const TOKEN = `mcp_${'T'.repeat(43)}`;
const AGENT_KEY = 'mk_ok';

interface Seen {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: string;
}

const seen: Seen[] = [];
let answer: (res: ServerResponse) => void = () => undefined;
let upstream: Server;
let upstreamBase = '';
let box: Server;
let boxBase = '';
let token: string | null = TOKEN;
let reregistered = 0;

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(randomInt(10_000, 30_000), '127.0.0.1', resolve);
  });
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
}

beforeAll(async () => {
  upstream = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
      answer(res);
    });
  });
  upstreamBase = await listen(upstream);
  const deps = (): RelayDeps => ({ url: upstreamBase, identify: (key) => key === AGENT_KEY, token: () => token, reregister: () => { reregistered += 1; } });
  box = createServer((req, res) => {
    if (!handleGatewayRelay(req, res, deps())) res.writeHead(404).end();
  });
  boxBase = await listen(box);
});

afterAll(() => {
  upstream.close();
  box.close();
});

beforeEach(() => {
  seen.length = 0;
  token = TOKEN;
  reregistered = 0;
  answer = (res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('event: message_start\ndata: {"type":"message_start"}\n\n');
  };
});

const ask = (path: string, headers: Record<string, string> = {}): Promise<Response> =>
  fetch(`${boxBase}/gateway${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-metro-key': AGENT_KEY, authorization: 'Bearer sk-ant-oat01-own-login', 'x-api-key': AGENT_KEY, 'x-claude-code-agent-id': 'worker-1', 'anthropic-beta': 'oauth-2025-04-20', ...headers },
    body: '{"model":"claude-sonnet-5-5","messages":[]}',
  });

describe('the box relays its model requests to gateway.metro.box', () => {
  test('the request goes up with the box token instead of any login or key, the hints kept, and the stream comes back', async () => {
    const res = await ask('/v1/messages?beta=true');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('message_start');
    expect(seen).toHaveLength(1);
    const [up] = seen;
    expect(up).toMatchObject({ method: 'POST', url: '/v1/messages?beta=true', body: '{"model":"claude-sonnet-5-5","messages":[]}' });
    expect(up?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(up?.headers['x-api-key']).toBeUndefined();
    expect(up?.headers['x-metro-key']).toBeUndefined();
    expect(up?.headers['x-claude-code-agent-id']).toBe('worker-1');
    expect(up?.headers['anthropic-beta']).toBe('oauth-2025-04-20');
  });

  test('without the agent key, or through the public address, nothing goes up', async () => {
    expect((await ask('/v1/messages', { 'x-metro-key': 'wrong' })).status).toBe(401);
    expect((await ask('/v1/messages', { 'x-forwarded-host': 'box.ts.net', 'x-forwarded-for': '1.2.3.4' })).status).toBe(401);
    expect((await ask('/v1/other')).status).toBe(404);
    expect(seen).toEqual([]);
  });

  test('an agent not linked yet gets a 503 that says so, and nothing goes up', async () => {
    token = null;
    const res = await ask('/v1/messages');
    expect(res.status).toBe(503);
    expect(await res.text()).toContain('not linked to its organization yet');
    expect(seen).toEqual([]);
  });

  test('a 401 from the gateway is never shown to Claude Code: a 503, and the token is registered again', async () => {
    answer = (res) => {
      res.writeHead(401, { 'content-type': 'application/json' }).end('{"type":"error","error":{"type":"authentication_error","message":"no"}}');
    };
    const res = await ask('/v1/messages');
    expect(res.status).toBe(503);
    expect(reregistered).toBe(1);
  });

  test('a gateway that cannot be reached is a 502 Claude Code retries, and HEAD hello stays local', async () => {
    const down: RelayDeps = { url: 'http://127.0.0.1:1', identify: () => true, token: () => TOKEN, reregister: () => undefined };
    const server = createServer((req, res) => {
      if (!handleGatewayRelay(req, res, down)) res.writeHead(404).end();
    });
    const base = await listen(server);
    try {
      expect((await fetch(`${base}/gateway/v1/messages`, { method: 'POST', headers: { 'x-metro-key': 'k' }, body: '{}' })).status).toBe(502);
      expect((await fetch(`${base}/gateway/api/hello`, { method: 'HEAD' })).status).toBe(200);
    } finally {
      server.close();
    }
  });
});

describe('METRO_GATEWAY_URL', () => {
  test('defaults to gateway.metro.box, empty keeps the box routing itself, and a plain http address elsewhere is ignored', () => {
    expect(gatewayUrl({})).toBe('https://gateway.metro.box');
    expect(gatewayUrl({ METRO_GATEWAY_URL: '' })).toBeNull();
    expect(gatewayUrl({ METRO_GATEWAY_URL: 'http://127.0.0.1:8440/' })).toBe('http://127.0.0.1:8440');
    expect(gatewayUrl({ METRO_GATEWAY_URL: 'http://gateway.example.com' })).toBeNull();
  });
});
