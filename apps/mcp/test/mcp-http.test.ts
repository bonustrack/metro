import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { agents } from '@metro-labs/connectors/db/schema';
import { agentKeyStore } from '@metro-labs/connectors/db/agent-keys';
import { MCP_INSTRUCTIONS } from '../src/tools.ts';
import { addConnector, assign, enrollAgent, headerSecret, newToken, PGLITE_START_MS, rpc, startApp, STRANGER, testDb, type TestAgent, type TestApp, type TestDb } from './helpers.ts';

let held: TestDb;
let app: TestApp;
let agent: TestAgent;

const never = (): Promise<Response> => Promise.reject(new Error('no vendor call expected'));

beforeAll(async () => { held = await testDb(); }, PGLITE_START_MS);
beforeEach(async () => {
  await held.reset();
  agent = await enrollAgent(held.db, 'agent000001');
  app = await startApp(held.db, never);
});
afterEach(async () => { await app.close(); });
afterAll(async () => { await held.close(); });

const initialize = (version = '2025-06-18') => ({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: version, capabilities: {}, clientInfo: { name: 'claude-code', version: '2' } } });

describe('the MCP token', () => {
  test('a missing, malformed or unknown token is 401 with WWW-Authenticate: Bearer', async () => {
    for (const token of [null, 'not-a-token', newToken()]) {
      const res = await rpc(app, token, initialize());
      expect(res.status).toBe(401);
      expect(res.headers.get('www-authenticate')).toBe('Bearer');
    }
    const basic = await rpc(app, null, initialize(), { authorization: `Basic ${agent.token}` });
    expect(basic.status).toBe(401);
  });

  test('a token whose agent left its organization stops working at once', async () => {
    expect((await rpc(app, agent.token, initialize())).status).toBe(200);
    await held.db.update(agents).set({ owner: STRANGER }).where(eq(agents.id, agent.row.agent));
    expect((await rpc(app, agent.token, initialize())).status).toBe(401);
  });

  test('enrolling the agent again cancels its token until the daemon registers a new one', async () => {
    expect((await rpc(app, agent.token, initialize())).status).toBe(200);
    await agentKeyStore(() => held.db).enroll({ ...agent.row, enrolledAt: new Date().toISOString() });
    expect((await rpc(app, agent.token, initialize())).status).toBe(401);
  });

  test('a token whose agent was deleted stops working', async () => {
    await held.db.delete(agents).where(eq(agents.id, agent.row.agent));
    expect((await rpc(app, agent.token, initialize())).status).toBe(401);
  });
});

describe('MCP over HTTP', () => {
  test('initialize echoes a supported version, names the server and mints a session id', async () => {
    const res = await rpc(app, agent.token, initialize('2025-03-26'));
    expect(res.status).toBe(200);
    expect(res.headers.get('mcp-session-id')).toMatch(/^[A-Za-z0-9_-]{22}$/);
    const body = await res.json() as { id: number; result: Record<string, unknown> };
    expect(body.id).toBe(1);
    expect(body.result).toMatchObject({ protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'metro' } });
    expect(String(body.result.instructions)).toContain('find_tools');
    expect(MCP_INSTRUCTIONS.length).toBeLessThan(1500);
    const unknown = await (await rpc(app, agent.token, initialize('1999-01-01'))).json() as { result: { protocolVersion: string } };
    expect(unknown.result.protocolVersion).toBe('2025-11-25');
  });

  test('a later request with any session id is accepted', async () => {
    const res = await rpc(app, agent.token, { jsonrpc: '2.0', id: 2, method: 'ping' }, { 'mcp-session-id': 'whatever-the-client-kept' });
    expect(await res.json()).toEqual({ jsonrpc: '2.0', id: 2, result: {} });
  });

  test('notifications get 202 and no body', async () => {
    const res = await rpc(app, agent.token, { jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(res.status).toBe(202);
    expect(await res.text()).toBe('');
  });

  test('tools/list has exactly find_tools and call_tool, and find_tools names the agent\'s connectors', async () => {
    await addConnector(held.db, 'conn0000001', 'Notion', headerSecret());
    await addConnector(held.db, 'conn0000002', 'n8n Anderra', headerSecret());
    await addConnector(held.db, 'conn0000003', 'Hidden', headerSecret(), { policy: '{"read":"deny","write":"deny"}' });
    await addConnector(held.db, 'conn0000004', 'Not mine', headerSecret());
    for (const id of ['conn0000001', 'conn0000002', 'conn0000003']) await assign(held.db, id, agent.row.agent);
    const body = await (await rpc(app, agent.token, { jsonrpc: '2.0', id: 3, method: 'tools/list' })).json() as { result: { tools: { name: string; description: string; inputSchema: { required: string[] }; annotations: Record<string, unknown> }[] } };
    const [find, call] = body.result.tools;
    expect(body.result.tools.map((tool) => tool.name)).toEqual(['find_tools', 'call_tool']);
    expect(find?.description).toContain("This agent's connectors: n8n-anderra, notion.");
    expect(find?.description).not.toContain('hidden');
    expect(find?.inputSchema.required).toEqual(['query']);
    expect(find?.annotations).toMatchObject({ readOnlyHint: true });
    expect(call?.inputSchema.required).toEqual(['calls']);
    expect(call?.annotations).toMatchObject({ destructiveHint: true, openWorldHint: true });
  });

  test('an unknown tool is a JSON-RPC error, bad arguments are a tool error', async () => {
    const unknown = await (await rpc(app, agent.token, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'notion.search', arguments: {} } })).json() as { error: { code: number } };
    expect(unknown.error.code).toBe(-32602);
    const bad = await (await rpc(app, agent.token, { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'call_tool', arguments: { calls: [] } } })).json() as { result: { isError: boolean; content: { text: string }[] } };
    expect(bad.result.isError).toBe(true);
    expect(bad.result.content[0]?.text).toContain('1 to 10 calls');
    const query = await (await rpc(app, agent.token, { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'find_tools', arguments: { query: '' } } })).json() as { result: { isError: boolean } };
    expect(query.result.isError).toBe(true);
  });

  test('an unknown method, a parse error and an invalid message are JSON-RPC errors', async () => {
    const method = await (await rpc(app, agent.token, { jsonrpc: '2.0', id: 8, method: 'resources/list' })).json() as { error: { code: number } };
    expect(method.error.code).toBe(-32601);
    const parse = await fetch(`${app.base}/`, { method: 'POST', headers: { authorization: `Bearer ${agent.token}` }, body: '{nope' });
    expect(parse.status).toBe(400);
    expect(((await parse.json()) as { error: { code: number } }).error.code).toBe(-32700);
    const invalid = await (await rpc(app, agent.token, { id: 9, method: 'ping' })).json() as { error: { code: number } };
    expect(invalid.error.code).toBe(-32600);
  });

  test('a batch answers its requests in one array', async () => {
    const res = await rpc(app, agent.token, [{ jsonrpc: '2.0', id: 'a', method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/initialized' }, { jsonrpc: '2.0', id: 'b', method: 'ping' }]);
    expect(await res.json()).toEqual([{ jsonrpc: '2.0', id: 'a', result: {} }, { jsonrpc: '2.0', id: 'b', result: {} }]);
  });

  test('GET and DELETE answer 405, other paths 404, /health is open', async () => {
    expect((await fetch(`${app.base}/mcp`, { headers: { authorization: `Bearer ${agent.token}` } })).status).toBe(405);
    expect((await fetch(`${app.base}/`, { method: 'DELETE' })).status).toBe(405);
    expect((await fetch(`${app.base}/elsewhere`, { method: 'POST' })).status).toBe(404);
    const health = await fetch(`${app.base}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ status: 'ok' });
  });

  test('a connector of another organization is never visible, even when assigned by mistake', async () => {
    await addConnector(held.db, 'conn0000009', 'Foreign', headerSecret(), { owner: STRANGER });
    await assign(held.db, 'conn0000009', agent.row.agent);
    const body = await (await rpc(app, agent.token, { jsonrpc: '2.0', id: 3, method: 'tools/list' })).json() as { result: { tools: { description: string }[] } };
    expect(body.result.tools[0]?.description).toContain('This agent has no connectors it may use yet.');
  });
});
