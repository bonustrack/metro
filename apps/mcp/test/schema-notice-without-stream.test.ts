import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { createMetroMcp } from '../src/mcp/index.ts';
import { setKeyMap } from '../src/db/key-map.ts';
import { setAgentMap } from '../src/db/agent-map.ts';

const TOKEN = 'mk_test_agent_key';
setKeyMap([{ key: TOKEN, agentId: 'agent000001' }]);
beforeAll(() => setAgentMap({ 'discord/acc': 'agent000001' }, { ['agent000001']: 'Tony' }));
afterAll(() => setAgentMap({}, {}));

const LIST_CHANGED = 'notifications/tools/list_changed';

const sseFrames = (chunk: string): Record<string, unknown>[] => {
  const out: Record<string, unknown>[] = [];
  for (const block of chunk.split('\n\n')) {
    const line = block.split('\n').find((l) => l.startsWith('data:'));
    if (!line) continue;
    const json = line.slice(5).trim();
    if (!json) continue;
    try {
      out.push(JSON.parse(json) as Record<string, unknown>);
    } catch {
      // priming / non-JSON frames
    }
  }
  return out;
};

let server: Server | undefined;
let url = '';

beforeAll(async () => {
  const handler = await createMetroMcp();
  handler.startInbound();
  server = createServer((req, res) => {
    void handler.httpHandler(req, res);
  });
  await new Promise<void>((r) => server?.listen(0, '127.0.0.1', () => r()));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp?token=${TOKEN}`;
});

afterAll(async () => {
  if (server) await new Promise<void>((r) => server?.close(() => r()));
});

const post = async (
  body: unknown,
  sessionId?: string,
): Promise<{ status: number; frames: Record<string, unknown>[] }> => {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, frames: sseFrames(await res.text()) };
};

const callTool = (id: number): Record<string, unknown> => ({
  jsonrpc: '2.0',
  id,
  method: 'tools/call',
  params: { name: 'list_accounts', arguments: {} },
});

const listTools = (id: number): Record<string, unknown> => ({
  jsonrpc: '2.0',
  id,
  method: 'tools/list',
  params: {},
});

const initialize = async (): Promise<string> => {
  const res = await fetch(url, {
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
  const sessionId = res.headers.get('mcp-session-id') ?? '';
  await res.body?.cancel();
  return sessionId;
};

describe('an adopted session with no standalone stream', () => {
  test('is told the schema moved on the response to its next tool call', async () => {
    const stale = randomUUID();
    const { status, frames } = await post(callTool(7), stale);

    expect(status).toBe(200);
    expect(frames.some((f) => f.method === LIST_CHANGED)).toBe(true);
    expect(frames.some((f) => f.id === 7)).toBe(true);
  }, 15000);

  test('is told only once, not on every subsequent tool call', async () => {
    const stale = randomUUID();
    const first = await post(callTool(1), stale);
    expect(first.frames.some((f) => f.method === LIST_CHANGED)).toBe(true);

    const second = await post(callTool(2), stale);
    expect(second.frames.some((f) => f.method === LIST_CHANGED)).toBe(false);
    expect(second.frames.some((f) => f.id === 2)).toBe(true);
  }, 15000);

  test('listing the tools settles the notice without sending one', async () => {
    const stale = randomUUID();
    const listed = await post(listTools(1), stale);
    expect(listed.frames.some((f) => f.method === LIST_CHANGED)).toBe(false);
    expect(listed.frames.some((f) => f.id === 1)).toBe(true);

    const called = await post(callTool(2), stale);
    expect(called.frames.some((f) => f.method === LIST_CHANGED)).toBe(false);
  }, 15000);
});

describe('a session the client initialized itself', () => {
  test('is never told the schema moved on a tool call', async () => {
    const sessionId = await initialize();
    expect(sessionId).not.toBe('');

    const { frames } = await post(callTool(9), sessionId);
    expect(frames.some((f) => f.method === LIST_CHANGED)).toBe(false);
    expect(frames.some((f) => f.id === 9)).toBe(true);
  }, 15000);
});
