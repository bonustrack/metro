import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { log } from '@metro-labs/core/log';
import { mcpServerTools } from '@metro-labs/http/mcp-server-tools';
import { callConnectorTool, connectorTools, connectorToolsVersion, NOT_SET_UP, onConnectorToolsChanged, refreshConnectorTools, UNAVAILABLE } from '../src/mcp-server/connector-tools.ts';
import { createMetroMcp } from '../src/mcp/index.ts';
import { setKeyMap } from '../src/agents/keys.ts';
import { setAgentMap } from '../src/agents/map.ts';
import { MCP_INSTRUCTIONS } from '../src/mcp/instructions.ts';
import { initSession, openGet } from './mcp-probe.ts';

const TOKEN = `mcp_${'t'.repeat(43)}`;
const KEY = 'mk_connector_tools_agent';
const AGENT = 'agent000001';

interface Seen {
  authorization: string;
  method: string;
  params: Record<string, unknown>;
}

interface Fake {
  url: string;
  seen: Seen[];
  status: number;
  tools: Record<string, unknown>[];
  answer: (params: Record<string, unknown>) => Record<string, unknown>;
  close: () => Promise<void>;
}

const port = (): number => 10_000 + Math.floor(Math.random() * 20_000);

async function listen(server: Server): Promise<number> {
  for (;;) {
    const at = port();
    const bound = await new Promise<boolean>((resolve) => {
      server.once('error', () => resolve(false));
      server.listen(at, '127.0.0.1', () => resolve(true));
    });
    if (bound) return at;
  }
}

async function fakeServer(): Promise<Fake> {
  const fake: Fake = {
    url: '',
    seen: [],
    status: 200,
    tools: mcpServerTools(['notion']) as unknown as Record<string, unknown>[],
    answer: () => ({ result: { content: [{ type: 'text', text: '[1] notion.search' }] } }),
    close: () => Promise.resolve(),
  };
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => { raw += chunk.toString('utf8'); });
    req.on('end', () => {
      const body = JSON.parse(raw) as { id: number; method: string; params: Record<string, unknown> };
      fake.seen.push({ authorization: req.headers.authorization ?? '', method: body.method, params: body.params });
      if (fake.status !== 200) {
        res.writeHead(fake.status).end('{}');
        return;
      }
      const reply = body.method === 'tools/list' ? { result: { tools: fake.tools } } : fake.answer(body.params);
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: body.id, ...reply }));
    });
  });
  fake.url = `http://127.0.0.1:${String(await listen(server))}`;
  fake.close = () => new Promise((resolve) => { server.close(() => resolve()); });
  return fake;
}

let fake: Fake;
let agents = '';
let reregistered = 0;
const deps = (): { url: string; token: string; reregister: () => void } => ({ url: fake.url, token: TOKEN, reregister: () => { reregistered += 1; } });
const text = (result: { content: unknown[] }): string => JSON.stringify(result.content);

beforeAll(async () => {
  fake = await fakeServer();
  agents = mkdtempSync(join(tmpdir(), 'metro-connector-tools-'));
});

beforeEach(() => {
  fake.seen.length = 0;
  fake.status = 200;
  reregistered = 0;
});

afterAll(async () => {
  fake.tools = mcpServerTools(null) as unknown as Record<string, unknown>[];
  await refreshConnectorTools(deps());
  await fake.close();
  rmSync(agents, { recursive: true, force: true });
});

describe('tool_search and tool_call forwarded to mcp.metro.box', () => {
  test('a result goes back as the server sent it: content, structured content and all, with the MCP token as bearer', async () => {
    const served = { content: [{ type: 'text', text: '[1] notion.search' }, { type: 'image', data: 'aGk=', mimeType: 'image/png' }], structuredContent: { pages: 2 } };
    fake.answer = () => ({ result: served });
    const args = { calls: [{ tool: 'notion.search', arguments: { query: 'roadmap' } }] };
    expect(await callConnectorTool('tool_call', args, deps())).toEqual(served);
    expect(fake.seen).toEqual([{ authorization: `Bearer ${TOKEN}`, method: 'tools/call', params: { name: 'tool_call', arguments: args } }]);
  });

  test('an error result goes back as an error, untouched', async () => {
    const served = { content: [{ type: 'text', text: '[1] notion.nope' }, { type: 'text', text: 'not_found: notion has no tool named nope. Run tool_search first.' }], isError: true };
    fake.answer = () => ({ result: served });
    expect(await callConnectorTool('tool_call', { calls: [{ tool: 'notion.nope' }] }, deps())).toEqual(served);
  });

  test('a 401 asks the link to register the token again and answers that the server is unavailable', async () => {
    fake.status = 401;
    const result = await callConnectorTool('tool_search', { query: 'notion' }, deps());
    expect(result).toEqual({ content: [{ type: 'text', text: UNAVAILABLE }], isError: true });
    expect(reregistered).toBe(1);
  });

  test('a 5xx, a refused connection or a JSON-RPC error never reaches the agent as a crash', async () => {
    fake.status = 503;
    expect(text(await callConnectorTool('tool_call', { calls: [] }, deps()))).toContain(UNAVAILABLE);
    fake.status = 200;
    fake.answer = () => ({ error: { code: -32602, message: 'Unknown tool: nope. This server has tool_search and tool_call.' } });
    expect(text(await callConnectorTool('nope', {}, deps()))).toContain('mcp.metro.box refused the call: Unknown tool: nope.');
    const closed = await fakeServer();
    await closed.close();
    expect(await callConnectorTool('tool_call', { calls: [] }, { ...deps(), url: closed.url })).toEqual({ content: [{ type: 'text', text: UNAVAILABLE }], isError: true });
    expect(reregistered).toBe(0);
  });

  test('with no token, or no server, connectors are not set up', async () => {
    expect(await callConnectorTool('tool_search', { query: 'x' }, { ...deps(), token: null })).toEqual({ content: [{ type: 'text', text: NOT_SET_UP }], isError: true });
    expect(text(await callConnectorTool('tool_search', { query: 'x' }, { ...deps(), url: null }))).toContain('Server page');
    expect(fake.seen).toEqual([]);
  });

  test('by default the token is Metro\'s own mcp-token and the url METRO_MCP_SERVER_URL; nothing of the call is logged', async () => {
    const saved = { dir: process.env.METRO_AGENTS_DIR, url: process.env.METRO_MCP_SERVER_URL };
    process.env.METRO_AGENTS_DIR = agents;
    process.env.METRO_MCP_SERVER_URL = fake.url;
    const logs = [spyOn(log, 'info'), spyOn(log, 'warn'), spyOn(log, 'debug')];
    try {
      expect(text(await callConnectorTool('tool_call', { calls: [] }))).toContain(NOT_SET_UP);
      writeFileSync(join(agents, 'mcp-token'), `${TOKEN}\n`);
      fake.answer = (params) => ({ result: { content: [{ type: 'text', text: `secret result for ${JSON.stringify(params.arguments)}` }] } });
      const result = await callConnectorTool('tool_call', { calls: [{ tool: 'notion.search', arguments: { query: 'private words' } }] });
      expect(text(result)).toContain('private words');
      expect(fake.seen.at(-1)?.authorization).toBe(`Bearer ${TOKEN}`);
      fake.status = 500;
      await callConnectorTool('tool_call', { calls: [{ tool: 'notion.search', arguments: { query: 'private words' } }] });
      const logged = JSON.stringify(logs.flatMap((spy) => spy.mock.calls));
      for (const secret of [TOKEN, 'private words', 'secret result']) expect(logged).not.toContain(secret);
    } finally {
      for (const spy of logs) spy.mockRestore();
      if (saved.dir === undefined) delete process.env.METRO_AGENTS_DIR;
      else process.env.METRO_AGENTS_DIR = saved.dir;
      if (saved.url === undefined) delete process.env.METRO_MCP_SERVER_URL;
      else process.env.METRO_MCP_SERVER_URL = saved.url;
    }
  });
});

describe('the instructions', () => {
  test('say connectors are reached only through tool_search then tool_call, from a worker, within what Claude Code keeps', () => {
    expect(MCP_INSTRUCTIONS).toContain('only through `tool_search` then `tool_call`, from a worker');
    expect(MCP_INSTRUCTIONS.length).toBeLessThanOrEqual(2048);
  });
});

describe('the descriptions come from mcp.metro.box', () => {
  test('a refresh takes the served tools, tells the listeners once, and keeps the last good list when the server is away', async () => {
    let told = 0;
    const stop = onConnectorToolsChanged(() => { told += 1; });
    try {
      fake.tools = mcpServerTools(['notion', 'n8n-anderra']) as unknown as Record<string, unknown>[];
      const before = connectorToolsVersion();
      expect(await refreshConnectorTools(deps())).toBe(true);
      expect(connectorToolsVersion()).toBe(before + 1);
      expect(connectorTools()[0]?.description).toContain("This agent's connectors: notion, n8n-anderra.");
      expect(await refreshConnectorTools(deps())).toBe(false);
      fake.status = 503;
      expect(await refreshConnectorTools(deps())).toBe(false);
      fake.status = 200;
      fake.tools = [{ name: 'tool_search', description: 'half a list', inputSchema: {} }];
      expect(await refreshConnectorTools(deps())).toBe(false);
      expect(connectorTools()[0]?.description).toContain('n8n-anderra');
      expect(told).toBe(1);
    } finally {
      stop();
    }
  });

  test('a live session is told the tool list changed, and lists the new descriptions', async () => {
    setKeyMap([{ key: KEY, agentId: AGENT }]);
    setAgentMap({ 'discord-bot/acc': AGENT }, { [AGENT]: 'Tony' });
    const mcp = await createMetroMcp();
    mcp.startInbound();
    const server = createServer((req, res) => {
      mcp.httpHandler(req, res).catch(() => res.writeHead(500).end());
    });
    const url = `http://127.0.0.1:${String(await listen(server))}/mcp?token=${KEY}`;
    try {
      const sessionId = await initSession(url);
      const stream = await openGet(url, sessionId);
      fake.tools = mcpServerTools(['linear']) as unknown as Record<string, unknown>[];
      expect(await refreshConnectorTools(deps())).toBe(true);
      for (let i = 0; i < 50 && !stream.raw().includes('notifications/tools/list_changed'); i += 1) await Bun.sleep(20);
      expect(stream.raw()).toContain('notifications/tools/list_changed');
      await stream.stop();
      const listed = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-session-id': sessionId },
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
      });
      const body = await listed.text();
      expect(body).toContain("This agent's connectors: linear.");
      expect(body).toContain('"name":"tool_call"');
    } finally {
      await new Promise<void>((resolve) => { server.close(() => resolve()); });
      setAgentMap({}, {});
    }
  }, 15_000);
});
