import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomInt, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { CHAT_MCP_HEADER } from '@metro-labs/core/chat';
import { publishEvent, type MetroEvent } from '@metro-labs/core/events';
import { asLine } from '@metro-labs/core/lines';
import { setKeyMap } from '../src/agents/keys.ts';
import { setAgentMap } from '../src/agents/map.ts';
import { createMetroMcp } from '../src/mcp/index.ts';
import { initSession, openGet, RUNNER } from './mcp-probe.ts';
import { settle, waitFor } from './wait.ts';

const TOKEN = 'mk_chat_side';
const ACCOUNT = 'a1-chatside';
const LINE = `metro://whatsapp/${ACCOUNT}/111@lid`;

let server: Server | undefined;
let url = '';

const HEADERS = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' };

const chatInit = async (): Promise<string> => {
  const res = await fetch(url, {
    method: 'POST',
    headers: { ...HEADERS, [CHAT_MCP_HEADER]: '1' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code', version: '0.0.0' } } }),
  });
  await res.body?.cancel();
  const id = res.headers.get('mcp-session-id');
  if (id === null) throw new Error('no session id');
  return id;
};

const toolsList = (sessionId: string | undefined, chat = true): Promise<Response> =>
  fetch(url, {
    method: 'POST',
    headers: { ...HEADERS, ...(chat ? { [CHAT_MCP_HEADER]: '1' } : {}), ...(sessionId === undefined ? {} : { 'mcp-session-id': sessionId }) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
  });

const chatGet = (sessionId: string): Promise<Response> => fetch(url, { method: 'GET', headers: { accept: 'text/event-stream', 'mcp-session-id': sessionId, [CHAT_MCP_HEADER]: '1' } });

const msg = (text: string): MetroEvent =>
  ({ id: `id-${randomUUID()}`, ts: new Date().toISOString(), station: 'whatsapp', line: asLine(LINE), from: asLine(`${LINE}/sender`), to: asLine(LINE), text, messageId: `m-${randomUUID()}`, event: { type: 'msg' } }) as unknown as MetroEvent;

beforeAll(async () => {
  setKeyMap([{ key: TOKEN, agentId: 'agent000001' }]);
  setAgentMap({ [`whatsapp/${ACCOUNT}`]: 'agent000001' }, { ['agent000001']: 'Tony' });
  const handler = await createMetroMcp();
  handler.startInbound();
  server = createServer((req, res) => {
    handler.httpHandler(req, res).catch(() => undefined);
  });
  const port = randomInt(10_000, 30_000);
  await new Promise<void>((r) => server?.listen(port, '127.0.0.1', () => r()));
  url = `http://127.0.0.1:${String(port)}/mcp?token=${TOKEN}`;
});

afterAll(async () => {
  setKeyMap([]);
  setAgentMap({}, {});
  if (server) await new Promise<void>((r) => server?.close(() => r()));
});

describe('the MCP client of a metro.box chat', () => {
  test('gets a side session while no runner holds the slot, so the slot stays empty and it never gets the chat stream', async () => {
    const chat = await chatInit();
    const listed = await toolsList(chat);
    expect(listed.status).toBe(200);
    expect(await listed.text()).toContain('"tools"');
    expect((await toolsList(undefined, false)).status).toBe(400);
    const stream = await chatGet(chat);
    expect(stream.status).toBe(405);
    await stream.body?.cancel();
  }, 30000);

  test('an unknown session id it presents is adopted as a side session, never as the agent session', async () => {
    const stale = randomUUID();
    const listed = await toolsList(stale);
    expect(listed.status).toBe(200);
    expect(listed.headers.get('mcp-session-id')).toBe(stale);
    await listed.text();
    expect((await toolsList(undefined, false)).status).toBe(400);
    const stream = await chatGet(stale);
    expect(stream.status).toBe(405);
    await stream.body?.cancel();
  }, 30000);

  test('while the runner holds the slot, a chat starting never moves it and the runner keeps getting messages', async () => {
    const agent = await initSession(url, RUNNER);
    const stream = await openGet(url, agent);
    await settle(150);
    const chat = await chatInit();
    expect(chat).not.toBe(agent);
    expect((await toolsList(chat)).status).toBe(200);
    const text = `while-a-chat-runs-${randomUUID()}`;
    publishEvent(msg(text));
    await waitFor(() => stream.raw().includes(text));
    expect(stream.ended()).toBe(false);
    await stream.stop();
  }, 30000);
});
