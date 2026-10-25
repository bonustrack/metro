import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { eq, sql } from 'drizzle-orm';
import { createAgentToken, revokeAgentToken, tokenHashOf } from '@metro-labs/connectors/db/agent-tokens';
import type { Database } from '@metro-labs/connectors/db/database';
import { approvalStore } from '@metro-labs/connectors/db/mcp-approvals';
import { agentKeys, agents, agentTokens, connectors, mcpApprovals, mcpCalls } from '@metro-labs/connectors/db/schema';
import { MCP_PATHS, mcpApprovalsOf } from '@metro-labs/http/mcp-server-protocol';
import { KEY_INSTRUCTIONS, REMOTE_INSTRUCTIONS } from '../src/tools.ts';
import { TOUCH_EVERY_MS } from '../src/token.ts';
import { addConnector, assign, callTool, enrollAgent, headerSecret, newToken, OWNER, signed, PGLITE_START_MS, rewrite, rpc, startApp, STRANGER, testDb, texts, type TestApp, type TestDb } from './helpers.ts';
import { startVendor, type FakeVendor } from './vendor.ts';

const REMOTE = 'remote00001';
const CONN = 'conn0000001';
const START = Date.parse('2026-10-23T09:00:00.000Z');

let held: TestDb;
let vendor: FakeVendor;
let app: TestApp;
let key = '';
let tokenId = '';
let now = START;

async function addRemote(db: Database, id: string, owner = OWNER): Promise<{ key: string; tokenId: string }> {
  await db.insert(agents).values({ id, owner, kind: 'remote', host: null, name: 'Laptop', addedAt: '2026-10-23T00:00:00.000Z', slug: id });
  const made = await createAgentToken(db, { owner, agent: id, label: 'Claude Code', createdBy: 'user_01TEST', now: START });
  return { key: made.token, tokenId: made.row.id };
}

const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'claude-code', version: '2' } } };

async function lastUsed(): Promise<number | null> {
  return (await held.db.select({ at: agentTokens.lastUsedAt }).from(agentTokens).where(eq(agentTokens.id, tokenId)))[0]?.at ?? null;
}

async function settled<T>(read: () => Promise<T>, wanted: T): Promise<T> {
  for (let i = 0; i < 50; i += 1) {
    const value = await read();
    if (value === wanted) return value;
    await Bun.sleep(10);
  }
  return read();
}

beforeAll(async () => {
  held = await testDb();
  vendor = await startVendor();
}, PGLITE_START_MS);

beforeEach(async () => {
  await held.reset();
  now = START;
  vendor.calls.length = 0;
  ({ key, tokenId } = await addRemote(held.db, REMOTE));
  await addConnector(held.db, CONN, 'Notion', headerSecret());
  await assign(held.db, CONN, REMOTE);
  app = await startApp(held.db, rewrite(vendor.base), { now: () => now });
});

afterEach(async () => {
  await app.close();
});

afterAll(async () => {
  await vendor.close();
  await held.close();
});

describe('an agent without a server, signed in with an access key', () => {
  test('initialize tells it approvals happen on metro.box, and tools/list says the same', async () => {
    const res = await rpc(app, key, initialize);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { instructions: string } };
    expect(body.result.instructions).toBe(REMOTE_INSTRUCTIONS);
    expect(body.result.instructions).not.toContain('from a worker');
    const list = (await (await rpc(app, key, { jsonrpc: '2.0', id: 2, method: 'tools/list' })).json()) as { result: { tools: { name: string; description: string }[] } };
    expect(list.result.tools.map((tool) => tool.name)).toEqual(['tool_search', 'tool_call']);
    expect(list.result.tools[0]?.description).toContain('This agent\'s connectors: notion.');
    expect(list.result.tools[1]?.description).toContain('approve it on this agent\'s page on metro.box');
  });

  test('tool_search and tool_call reach its connectors, and each call is recorded for it', async () => {
    expect(texts(await callTool(app, key, 'tool_search', { query: 'select:notion.search' }))[0]).toContain('"name":"notion.search"');
    const result = await callTool(app, key, 'tool_call', { calls: [{ tool: 'notion.search', arguments: { query: 'roadmap' } }] });
    expect(texts(result)).toEqual(['[1] notion.search', 'search ran with {"query":"roadmap"}']);
    expect(vendor.calls).toEqual([{ tool: 'search', arguments: { query: 'roadmap' }, authorization: 'Bearer VENDOR_KEY' }]);
    const recorded = await settled(async () => held.db.$count(mcpCalls, eq(mcpCalls.agent, REMOTE)), 1);
    expect(recorded).toBe(1);
  });

  test('an Ask tool waits for an answer on metro.box, then runs once with the approval id', async () => {
    await held.db.update(connectors).set({ policy: JSON.stringify({ write: 'ask' }) }).where(eq(connectors.id, CONN));
    const call = { tool: 'notion.update_page', arguments: { page_id: 'p1', title: 'Plan' } };
    const asked = texts(await callTool(app, key, 'tool_call', { calls: [call] }))[1] ?? '';
    const id = /approval ([a-km-z]{5})/.exec(asked)?.[1] ?? '';
    expect(asked).toStartWith('needs_approval: The owner must approve notion.update_page with these arguments first');
    expect(asked).toContain('on this agent\'s page on metro.box');
    expect(asked).not.toContain('in chat');
    expect(vendor.calls).toEqual([]);
    expect((await held.db.select().from(mcpApprovals))[0]).toMatchObject({ id, agent: REMOTE, owner: OWNER, state: 'pending', origin: 'key', token: tokenId });
    expect(await approvalStore(() => held.db).answer({ agent: REMOTE, owner: OWNER }, id, 'allow', now)).toBe(true);
    const ran = texts(await callTool(app, key, 'tool_call', { calls: [{ ...call, approval: id }] }));
    expect(ran).toEqual(['[1] notion.update_page', 'update_page ran with {"page_id":"p1","title":"Plan"}']);
    const again = texts(await callTool(app, key, 'tool_call', { calls: [{ ...call, approval: id }] }))[1] ?? '';
    expect(again).toStartWith('needs_approval:');
    expect(vendor.calls).toHaveLength(1);
  });

  test('a revoked key, a deleted agent and a moved agent are refused', async () => {
    expect((await rpc(app, key, initialize)).status).toBe(200);
    await revokeAgentToken(held.db, OWNER, REMOTE, tokenId, now);
    expect((await rpc(app, key, initialize)).status).toBe(401);
    const second = await createAgentToken(held.db, { owner: OWNER, agent: REMOTE, label: 'again', createdBy: 'user_01TEST', now });
    expect((await rpc(app, second.token, initialize)).status).toBe(200);
    await held.db.update(agents).set({ owner: STRANGER }).where(eq(agents.id, REMOTE));
    expect((await rpc(app, second.token, initialize)).status).toBe(401);
    await held.db.update(agents).set({ owner: OWNER }).where(eq(agents.id, REMOTE));
    await held.db.delete(agents).where(eq(agents.id, REMOTE));
    expect((await rpc(app, second.token, initialize)).status).toBe(401);
  });

  test('a key reaches only its own agent\'s connectors, and a box token works as before', async () => {
    const box = await enrollAgent(held.db, 'agent000001');
    await addConnector(held.db, 'conn0000002', 'Linear', headerSecret('/linear'));
    await assign(held.db, 'conn0000002', box.row.agent);
    expect(texts(await callTool(app, key, 'tool_search', { query: 'linear' }))[0]).toStartWith('No tool matched "linear". This agent\'s connectors: notion.');
    const boxInit = (await (await rpc(app, box.token, initialize)).json()) as { result: { instructions: string } };
    expect(boxInit.result.instructions).toContain('from a worker');
    const other = await addRemote(held.db, 'remote00002', STRANGER);
    expect(texts(await callTool(app, other.key, 'tool_search', { query: 'notion' }))[0]).toBe('No tool matched "notion". This agent has no connectors it may use.');
  });

  test('a key of an agent with a server works as that agent, and its Ask goes through the daemon relay as today', async () => {
    const box = await enrollAgent(held.db, 'agent000001');
    await addConnector(held.db, 'conn0000002', 'Linear', headerSecret('/mcp'), { policy: JSON.stringify({ write: 'ask' }) });
    await assign(held.db, 'conn0000002', box.row.agent);
    const made = await createAgentToken(held.db, { owner: OWNER, agent: box.row.agent, label: 'Laptop', createdBy: 'user_01TEST', now });
    const init = (await (await rpc(app, made.token, initialize)).json()) as { result: { instructions: string } };
    expect(init.result.instructions).toBe(KEY_INSTRUCTIONS);
    expect(texts(await callTool(app, made.token, 'tool_search', { query: 'select:linear.search' }))[0]).toContain('"name":"linear.search"');
    const call = { tool: 'linear.update_page', arguments: { page_id: 'p9' } };
    const asked = texts(await callTool(app, made.token, 'tool_call', { calls: [call] }))[1] ?? '';
    const id = /approval ([a-km-z]{5})/.exec(asked)?.[1] ?? '';
    expect(asked).toContain('The agent\'s owner was asked in chat and on its page on metro.box.');
    now += 1;
    const own = texts(await callTool(app, box.token, 'tool_call', { calls: [call] }))[1] ?? '';
    const ownId = /approval ([a-km-z]{5})/.exec(own)?.[1] ?? '';
    expect(ownId).not.toBe(id);
    const relayed = signed(box, MCP_PATHS.approvals, {}, now);
    const pending = mcpApprovalsOf(await (await fetch(`${app.base}${MCP_PATHS.approvals}`, { method: 'POST', body: relayed.body, headers: relayed.headers })).json());
    expect(pending.map((one) => [one.id, one.connector, one.tool, one.origin, one.keyLabel])).toEqual([[id, 'linear', 'update_page', 'key', 'Laptop'], [ownId, 'linear', 'update_page', 'box', undefined]]);
    expect((await held.db.select({ origin: mcpApprovals.origin, token: mcpApprovals.token }).from(mcpApprovals).where(eq(mcpApprovals.id, id)))[0]).toEqual({ origin: 'key', token: made.row.id });
    const answer = signed(box, MCP_PATHS.answer, { id, decision: 'allow' }, now);
    expect((await fetch(`${app.base}${MCP_PATHS.answer}`, { method: 'POST', body: answer.body, headers: answer.headers })).status).toBe(200);
    expect(texts(await callTool(app, made.token, 'tool_call', { calls: [{ ...call, approval: id }] }))).toEqual(['[1] linear.update_page', 'update_page ran with {"page_id":"p9"}']);
    expect((await held.db.select({ agent: mcpCalls.agent }).from(mcpCalls).where(eq(mcpCalls.connector, 'conn0000002'))).length).toBeGreaterThan(0);
  });

  test('a daemon MCP token on a row without a server opens nothing', async () => {
    const stray = newToken();
    await held.db.insert(agentKeys).values({ agent: REMOTE, owner: OWNER, keyId: 'strayKeyId01', signingKey: 'stray', enrolledBy: 'user_01TEST', enrolledAt: new Date().toISOString(), mcpTokenHash: tokenHashOf(stray) });
    expect((await rpc(app, stray, initialize)).status).toBe(401);
    expect((await rpc(app, key, initialize)).status).toBe(200);
  });

  test('last use is noted at most once a minute, off the request path', async () => {
    expect(await lastUsed()).toBeNull();
    await rpc(app, key, initialize);
    expect(await settled(lastUsed, START)).toBe(START);
    now = START + TOUCH_EVERY_MS - 1;
    await rpc(app, key, initialize);
    await Bun.sleep(30);
    expect(await lastUsed()).toBe(START);
    now = START + TOUCH_EVERY_MS;
    await rpc(app, key, initialize);
    expect(await settled(lastUsed, now)).toBe(now);
  });
});

describe('the scopes of an access key', () => {
  test('a key made for the gateway only is refused here, one with both scopes works', async () => {
    const only = await createAgentToken(held.db, { owner: OWNER, agent: REMOTE, label: 'Dashboard', createdBy: 'user_01TEST', now: START, scopes: ['gateway'] });
    expect((await rpc(app, only.token, initialize)).status).toBe(401);
    const both = await createAgentToken(held.db, { owner: OWNER, agent: REMOTE, label: 'Both', createdBy: 'user_01TEST', now: START, scopes: ['connectors', 'gateway'] });
    expect((await rpc(app, both.token, initialize)).status).toBe(200);
    expect((await rpc(app, key, initialize)).status).toBe(200);
  });
});

describe('before api.metro.box has migrated', () => {
  let early: TestDb;
  let earlyApp: TestApp;

  beforeAll(async () => {
    early = await testDb();
  }, PGLITE_START_MS);

  afterAll(async () => {
    await early.close();
  });

  test('a database without the agent_tokens table still serves boxes and refuses access keys with 401', async () => {
    const box = await enrollAgent(early.db, 'agent000009');
    await early.db.execute(sql`DROP TABLE agent_tokens`);
    earlyApp = await startApp(early.db, rewrite(vendor.base));
    try {
      expect((await rpc(earlyApp, box.token, initialize)).status).toBe(200);
      expect((await rpc(earlyApp, `mcp_${'A'.repeat(43)}`, initialize)).status).toBe(401);
    } finally {
      await earlyApp.close();
    }
  });

  test('a database without the scopes column reads every key as connectors only', async () => {
    const before = await testDb();
    const made = await addRemote(before.db, 'remote00009');
    await before.db.execute(sql`ALTER TABLE agent_tokens DROP COLUMN scopes`);
    const beforeApp = await startApp(before.db, rewrite(vendor.base));
    try {
      expect((await rpc(beforeApp, made.key, initialize)).status).toBe(200);
    } finally {
      await beforeApp.close();
      await before.close();
    }
  }, PGLITE_START_MS);
});
