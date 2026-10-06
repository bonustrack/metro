import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createServer, type IncomingMessage, type Server as HttpServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { CALL_NOTICE, CALL_STATE, type CallNotice, type CallRoute, type CallState } from '@metro-labs/core/call';
import type { ChannelEvent } from '../src/channel-text.ts';
import { MetroLink } from '../src/link.ts';
import { metroTools } from '../src/tool-proxy.ts';

const KEY = 'mk_link_test';
const PORT = 10000 + Math.floor(Math.random() * 19000);
const PermissionRequest = z.object({ method: z.literal('notifications/claude/channel/permission_request'), params: z.object({ request_id: z.string(), tool_name: z.string() }).passthrough() });
const PermissionCancel = z.object({ method: z.literal('notifications/metro/permission_cancel'), params: z.object({ request_id: z.string() }) });
const route: CallRoute = { agentId: 'agent', line: 'metro://xmtp/a/c', from: 'metro://xmtp/a/user/caller', callId: 'call', generation: 'generation' };

let http: HttpServer;
let daemon: Server | null = null;
const calls: unknown[] = [];
const asked: string[] = [];
const cancelled: string[] = [];
const notices: CallNotice[] = [];
const states: CallState[] = [];
const bindings: unknown[] = [];
const events: ChannelEvent[] = [];
const models: (string | null)[] = [];
let link: MetroLink;

function fakeDaemon(): Server {
  const server = new Server({ name: 'metro', version: '0' }, { capabilities: { tools: { listChanged: true }, experimental: { 'claude/channel': {} } }, instructions: 'metro rules' });
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [
      { name: 'send', inputSchema: { type: 'object' }, annotations: { readOnlyHint: false }, _meta: { 'anthropic/alwaysLoad': true } },
      { name: 'read', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, (request) => {
    calls.push(request.params);
    return { content: [{ type: 'text', text: `sent: ${String(request.params.arguments?.text)}` }] };
  });
  server.setNotificationHandler(PermissionRequest, async (n) => {
    asked.push(n.params.tool_name);
    if (n.params.call !== undefined) bindings.push(n.params.call);
    if (n.params.request_id === 'efghj') return;
    await server.notification({ method: 'notifications/claude/channel/permission', params: { request_id: n.params.request_id, behavior: n.params.tool_name === 'Bash' ? 'deny' : 'allow' } });
  });
  server.setNotificationHandler(PermissionCancel, (n) => { cancelled.push(n.params.request_id); });
  return server;
}

const body = async (req: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return chunks.length === 0 ? undefined : JSON.parse(Buffer.concat(chunks).toString('utf8'));
};

beforeAll(async () => {
  let transport: StreamableHTTPServerTransport | null = null;
  http = createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${KEY}`) {
      res.writeHead(401).end();
      return;
    }
    (async () => {
      if (transport === null) {
        transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
        daemon = fakeDaemon();
        await daemon.connect(transport);
      }
      await transport.handleRequest(req, res, req.method === 'POST' ? await body(req) : undefined);
    })().catch(() => res.writeHead(500).end());
  });
  await new Promise<void>((resolve) => http.listen(PORT, '127.0.0.1', () => resolve()));
  link = await MetroLink.open(`http://127.0.0.1:${String(PORT)}/mcp`, KEY, {
    channel: (event) => events.push(event),
    call: (notice) => notices.push(notice),
    callState: (state) => states.push(state),
    toolsChanged: () => undefined,
    model: (model) => models.push(model),
    lost: () => undefined,
  });
});

afterAll(async () => {
  await link.close();
  http.close();
});

test('the runner holds the metro chat link: channel messages come in, approvals go out and come back', async () => {
  expect(link.instructions).toBe('metro rules');
  for (let i = 0; i < 100 && events.length === 0; i += 1) {
    await daemon?.notification({ method: 'notifications/claude/channel', params: { content: 'hello', meta: { line: 'metro://xmtp/a/b' } } });
    await Bun.sleep(50);
  }
  expect(events[0]).toEqual({ content: 'hello', meta: { line: 'metro://xmtp/a/b' } });
  const signal = new AbortController().signal;
  expect(await link.ask({ request_id: 'abcde', tool_name: 'mcp__metro__send', description: '', input_preview: '{}' }, signal)).toBe('allow');
  expect(await link.ask({ request_id: 'bcdef', tool_name: 'Bash', description: '', input_preview: '{}' }, signal)).toBe('deny');
  expect(asked).toEqual(['mcp__metro__send', 'Bash']);
  const stopped = new AbortController();
  const pending = link.ask({ request_id: 'cdefg', tool_name: 'Read', description: '', input_preview: '{}' }, stopped.signal);
  stopped.abort();
  expect(await pending).toBe('deny');
});

test('an already cancelled approval is denied without sending an owner request', async () => {
  const stopped = new AbortController();
  stopped.abort();
  expect(await link.ask({ request_id: 'defgh', tool_name: 'CancelledRead', description: '', input_preview: '{}' }, stopped.signal)).toBe('deny');
  await link.listTools();
  expect(asked).not.toContain('CancelledRead');
});

test('a call-bound approval is correlated over the wire and explicitly cancelled on abort', async () => {
  const stopped = new AbortController();
  const call = { route, sourceId: 'heard' };
  const pending = link.ask({ request_id: 'efghj', tool_name: 'mcp__metro__send', description: '', input_preview: '{}', call }, stopped.signal);
  for (let i = 0; i < 100 && bindings.length === 0; i += 1) await Bun.sleep(20);
  expect(bindings).toEqual([call]);
  stopped.abort();
  expect(await pending).toBe('deny');
  for (let i = 0; i < 100 && !cancelled.includes('efghj'); i += 1) await Bun.sleep(20);
  expect(cancelled).toContain('efghj');
  await daemon?.notification({ method: 'notifications/claude/channel/permission', params: { request_id: 'efghj', behavior: 'allow' } });
  expect(await pending).toBe('deny');
});

test('validated call events arrive on the same authenticated link without entering chat', async () => {
  const valid: CallNotice[] = [
    { type: 'started', route, sourceId: 'greeting' },
    { type: 'heard', route, sourceId: 'heard', text: 'hello' },
    { type: 'speech', route, sourceId: 'heard', actionId: 'action', status: 'completed' },
    { type: 'ended', route },
  ];
  const chatCount = events.length;
  await daemon?.notification({ method: CALL_NOTICE, params: { type: 'heard', route, text: 'missing source' } });
  await daemon?.notification({ method: CALL_NOTICE, params: { type: 'started', route: { ...route, generation: '' }, sourceId: 'invalid' } });
  await daemon?.notification({ method: CALL_NOTICE, params: { type: 'speech', route, sourceId: 'heard', actionId: 'action', status: 'unknown' } });
  for (const notice of valid) await daemon?.notification({ method: CALL_NOTICE, params: { ...notice } });
  for (let i = 0; i < 100 && notices.length < valid.length; i += 1) await Bun.sleep(20);
  expect(notices).toEqual(valid);
  expect(events).toHaveLength(chatCount);
});

test('current call snapshots are validated separately from ephemeral call events', async () => {
  const noticeCount = notices.length;
  await daemon?.notification({ method: CALL_STATE, params: {} });
  await daemon?.notification({ method: CALL_STATE, params: { route: { ...route, generation: '' } } });
  await daemon?.notification({ method: CALL_STATE, params: { route } });
  await daemon?.notification({ method: CALL_STATE, params: { route: null } });
  for (let i = 0; i < 100 && states.length < 2; i += 1) await Bun.sleep(20);
  expect(states).toEqual([{ route }, { route: null }]);
  expect(notices).toHaveLength(noticeCount);
});

test('the session sees metro tools through the proxy, with their metadata, and calls reach metro', async () => {
  const tools = metroTools(link);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'claude', version: '0' });
  await Promise.all([tools.config.instance.connect(a), client.connect(b)]);
  expect(client.getInstructions()).toBe('metro rules');
  const listed = await client.listTools();
  expect(listed.tools.map((t) => t.name)).toEqual(['send', 'read']);
  expect(listed.tools[0]?._meta).toEqual({ 'anthropic/alwaysLoad': true });
  expect(tools.readOnly('read')).toBe(true);
  expect(tools.readOnly('send')).toBe(false);
  const answer = await client.callTool({ name: 'send', arguments: { line: 'l', text: 'hi' } });
  expect(answer.content).toEqual([{ type: 'text', text: 'sent: hi' }]);
  expect(calls).toEqual([{ name: 'send', arguments: { line: 'l', text: 'hi' } }]);
  await client.close();
});

test('a model the daemon announces reaches the runner, and an empty one means no model', async () => {
  await daemon?.notification({ method: 'notifications/metro/model', params: { model: 'openrouter:anthropic/claude-sonnet-5.5' } });
  await daemon?.notification({ method: 'notifications/metro/model', params: { model: null } });
  await daemon?.notification({ method: 'notifications/metro/model', params: { model: '' } });
  for (let i = 0; i < 100 && models.length < 3; i += 1) await Bun.sleep(20);
  expect(models).toEqual(['openrouter:anthropic/claude-sonnet-5.5', null, null]);
});
