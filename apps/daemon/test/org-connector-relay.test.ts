import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { ApiError } from '@metro-labs/http/api-error';
import { answerPrompt, forgetAllPrompts, holdPrompt } from '../src/approvals/pending.ts';
import { connectorGates, registerConnectors, requestConnectorBlocker } from '../src/connectors/gates.ts';
import { handleRelayRequest, type RelayApiDeps } from '../src/connectors/relay.ts';
import type { ToolPolicy } from '../src/policy/policy.ts';

const ID = 'org-conn0000001';
const KEY = 'local-agent-key';
const VENDOR = 'vendor-only-secret';
let upstream: Server;
let relay: Server;
let calls: { body: unknown; headers: IncomingMessage['headers'] }[] = [];
let refusals = 0;
let sse = false;
let targetCalls: boolean[] = [];
let closed = 0;
let beforeTarget: (force: boolean) => Promise<void> = () => Promise.resolve();
let currentError: ApiError | null = null;
let targetError: Error | null = null;
let enabled = true;
let upstreamBase = '';
let base = '';

function policy(value: ToolPolicy): void {
  registerConnectors([{ id: ID, name: 'Shared', config: { policy: value, toolGroups: { read: 'read', write: 'write' } } }]);
}

const target = () => {
  if (currentError !== null) throw currentError;
  return { kind: 'ok' as const, url: `${upstreamBase}/mcp?secret=target-only-secret`, headers: { Authorization: `Bearer ${VENDOR}` } };
};

const deps: RelayApiDeps = {
  identify: (req) => req.headers.authorization === `Bearer ${KEY}` ? { subject: 'agent-key', agentId: 'agent000001' } : null,
  open: () => {
    if (!enabled) throw new ApiError('Organization connectors are not available on this agent.', 503);
    return {
      target: async (force) => {
        targetCalls.push(force);
        await beforeTarget(force);
        if (targetError !== null) throw targetError;
        return target();
      },
      current: target,
      blocker: requestConnectorBlocker(),
      signal: new AbortController().signal,
      close: () => { closed += 1; },
    };
  },
};

async function vendor(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const body: unknown = JSON.parse(Buffer.concat(chunks).toString());
  calls.push({ body, headers: req.headers });
  if (refusals-- > 0) { res.writeHead(401).end(); return; }
  const result = (item: unknown) => typeof item === 'object' && item !== null && 'id' in item ? { jsonrpc: '2.0', id: item.id, result: { ok: true } } : null;
  const reply = Array.isArray(body) ? body.map(result).filter((item) => item !== null) : result(body);
  res.writeHead(200, { 'content-type': sse ? 'text/event-stream' : 'application/json' });
  res.end(sse ? `event: message\ndata: ${JSON.stringify(reply)}\n\n` : JSON.stringify(reply));
}

beforeAll(async () => {
  upstream = createServer((req, res) => { vendor(req, res).catch(() => res.writeHead(500).end()); });
  relay = createServer((req, res) => { handleRelayRequest(req, res, deps); });
  const port = 25_800 + Math.floor(Math.random() * 100);
  await new Promise<void>((done) => upstream.listen(port, '127.0.0.1', done));
  await new Promise<void>((done) => relay.listen(port + 100, '127.0.0.1', done));
  upstreamBase = `http://127.0.0.1:${String(port)}`;
  base = `http://127.0.0.1:${String(port + 100)}`;
});

afterAll(() => { upstream.close(); relay.close(); registerConnectors([]); forgetAllPrompts(); });
beforeEach(() => {
  calls = []; refusals = 0; sse = false; targetCalls = []; closed = 0;
  beforeTarget = () => Promise.resolve(); currentError = null; targetError = null; enabled = true;
  forgetAllPrompts(); policy({});
});

const call = (id: number, name = 'write') => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: { item: 'same' } } });
async function post(body: unknown): Promise<{ status: number; text: string }> {
  const response = await fetch(`${base}/relay/${ID}`, { method: 'POST', headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json', 'x-private': 'caller-only' }, body: JSON.stringify(body) });
  return { status: response.status, text: await response.text() };
}
async function grant(): Promise<void> {
  const server = connectorGates()[0]?.server ?? '';
  holdPrompt({ requestId: 'orgqa', tool: `mcp__plugin_metro_${server}__write`, description: '', preview: '{"item":"same"}', line: undefined, at: Date.now() }, {}, () => Promise.resolve());
  await answerPrompt('orgqa', 'allow', 'chat');
}

test('org forwarding injects the vendor credential, strips caller headers, and closes the session', async () => {
  const response = await post(call(1));
  expect(response.status).toBe(200);
  expect(calls[0]?.headers.authorization).toBe(`Bearer ${VENDOR}`);
  expect(calls[0]?.headers['x-private']).toBeUndefined();
  expect(targetCalls).toEqual([false]);
  expect(closed).toBe(1);
});

test('a stricter policy installed during initial resolution is checked before vendor dispatch', async () => {
  beforeTarget = async () => { await Promise.resolve(); policy({ write: 'deny' }); };
  const response = await post(call(1));
  expect(response.status).toBe(200);
  expect(response.text).toContain('Blocked by');
  expect(calls).toEqual([]);
});

test('assignment loss and typed unavailability during resolution preserve their HTTP status', async () => {
  for (const status of [404, 424, 503]) {
    beforeTarget = async () => { await Promise.resolve(); currentError = new ApiError('Not available.', status); };
    expect((await post(call(status))).status).toBe(status);
  }
  expect(calls).toEqual([]);
});

test('forced refresh rechecks policy, and does not retry a newly denied call', async () => {
  refusals = 1;
  beforeTarget = async (force) => { await Promise.resolve(); if (force) policy({ write: 'deny' }); };
  expect((await post(call(1))).text).toContain('Blocked by');
  expect(targetCalls).toEqual([false, true]);
  expect(calls).toHaveLength(1);
});

test('forced refresh never turns missing or unavailable into sign-in', async () => {
  for (const status of [404, 503]) {
    currentError = null; refusals = 1;
    beforeTarget = async (force) => { await Promise.resolve(); if (force) currentError = new ApiError('Not available.', status); };
    expect((await post(call(status))).status).toBe(status);
  }
  expect(calls).toHaveLength(2);
});

test('one ask grant authorizes the one bounded credential retry, never the next request', async () => {
  policy({ write: 'ask' }); await grant(); refusals = 1;
  expect((await post(call(1))).status).toBe(200);
  expect(calls).toHaveLength(2);
  expect((await post(call(2))).text).toContain("Needs the owner's approval");
  expect(calls).toHaveLength(2);
});

test('duplicate batch calls cannot reuse a single grant, even across retry', async () => {
  policy({ write: 'ask' }); await grant(); refusals = 1;
  const response = await post([call(1), call(2)]);
  expect(calls.map((entry) => entry.body)).toEqual([[call(1)], [call(1)]]);
  expect(JSON.parse(response.text)).toEqual([
    { jsonrpc: '2.0', id: 1, result: { ok: true } },
    { jsonrpc: '2.0', id: 2, result: { isError: true, content: [{ type: 'text', text: expect.any(String) }] } },
  ]);
});

test('mixed SSE batches retain blocked answers without forwarding them on retry', async () => {
  policy({ write: 'deny' }); refusals = 1; sse = true;
  const response = await post([call(1, 'read'), call(2)]);
  expect(calls.map((entry) => entry.body)).toEqual([[call(1, 'read')], [call(1, 'read')]]);
  expect(response.text).toContain('"ok":true');
  expect(response.text).toContain('"isError":true');
});

test('upstream refusal is at most two attempts and 424', async () => {
  refusals = 3;
  expect((await post(call(1))).status).toBe(424);
  expect(calls).toHaveLength(2);
  expect(targetCalls).toEqual([false, true]);
});

test('organization connectors switched off answer 503 and nothing reaches the vendor', async () => {
  enabled = false;
  expect((await post(call(1))).status).toBe(503);
  expect(calls).toEqual([]);
});

test('malformed calls and non-tool MCP operations cannot bypass organization policies', async () => {
  for (const body of [[], {}, { jsonrpc: '2.0', id: 1, method: 'resources/read' }, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'write', arguments: [] } }]) expect((await post(body)).status).toBe(400);
  expect(calls).toEqual([]);
  expect(targetCalls).toEqual([]);
});

test('unexpected organization failures never return a credential-bearing cause', async () => {
  targetError = new Error(`failed ${VENDOR} target-only-secret`);
  const response = await post(call(1));
  expect(response.status).toBe(503);
  expect(response.text).not.toContain(VENDOR);
  expect(response.text).not.toContain('target-only-secret');
});
