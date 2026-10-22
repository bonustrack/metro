import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { MCP_PATHS, mcpApprovalsOf } from '@metro-labs/http/mcp-server-protocol';
import { agentKeys, agents, mcpApprovals } from '@metro-labs/connectors/db/schema';
import { REDELIVER_MS } from '@metro-labs/connectors/db/mcp-approvals';
import { argsDigest } from '../src/digest.ts';
import { tokenHashOf } from '@metro-labs/connectors/db/agent-tokens';
import { addConnector, assign, enrollAgent, headerSecret, newToken, PGLITE_START_MS, rpc, signed, startApp, STRANGER, testDb, type TestAgent, type TestApp, type TestDb } from './helpers.ts';

let held: TestDb;
let app: TestApp;
let agent: TestAgent;
let other: TestAgent;
let clock = Date.parse('2026-10-14T10:00:00.000Z');

const never = (): Promise<Response> => Promise.reject(new Error('no vendor call expected'));
const post = (who: TestAgent, path: string, input: unknown, headers: Record<string, string> = {}): Promise<Response> => {
  const request = signed(who, path, input, clock);
  return fetch(`${app.base}${path}`, { method: 'POST', body: request.body, headers: { ...request.headers, ...headers } });
};

async function pending(who: TestAgent, tool = 'update_page', args: Record<string, unknown> = { page: 1 }, at = clock): Promise<string> {
  return app.deps.approvals.request(who.row, { connector: 'conn0000001', tool, digest: argsDigest(args), preview: JSON.stringify(args) }, at);
}

beforeAll(async () => { held = await testDb(); }, PGLITE_START_MS);
beforeEach(async () => {
  await held.reset();
  clock = Date.parse('2026-10-14T10:00:00.000Z');
  agent = await enrollAgent(held.db, 'agent000001');
  other = await enrollAgent(held.db, 'agent000002');
  await addConnector(held.db, 'conn0000001', 'Notion', headerSecret());
  await assign(held.db, 'conn0000001', agent.row.agent);
  app = await startApp(held.db, never, { now: () => clock, approvalHoldMs: 300, approvalPollMs: 50 });
});
afterEach(async () => { await app.close(); });
afterAll(async () => { await held.close(); });

describe('daemon requests are signed with the agent key', () => {
  test('unsigned, forged, browser and replayed requests are refused', async () => {
    expect((await fetch(`${app.base}${MCP_PATHS.approvals}`, { method: 'POST', body: '{}' })).status).toBe(401);
    expect((await post(agent, MCP_PATHS.approvals, {}, { origin: 'https://evil.example' })).status).toBe(403);
    const request = signed(agent, MCP_PATHS.token, { tokenHash: tokenHashOf(newToken()) }, clock);
    const forged = await fetch(`${app.base}${MCP_PATHS.token}`, { method: 'POST', headers: request.headers, body: JSON.stringify({ tokenHash: tokenHashOf(newToken()) }) });
    expect(forged.status).toBe(401);
    const first = await fetch(`${app.base}${MCP_PATHS.token}`, { method: 'POST', headers: request.headers, body: request.body });
    expect(first.status).toBe(200);
    const replay = await fetch(`${app.base}${MCP_PATHS.token}`, { method: 'POST', headers: request.headers, body: request.body });
    expect(replay.status).toBe(401);
    expect((await fetch(`${app.base}${MCP_PATHS.token}`)).status).toBe(405);
  });

  test('a request signed for another host is refused', async () => {
    const body = JSON.stringify({});
    const { signAgentRequest } = await import('@metro-labs/http/agent-signature');
    const authorization = signAgentRequest({ method: 'POST', host: 'api.metro.box', path: MCP_PATHS.approvals, body: Buffer.from(body) }, agent.signing, agent.row.keyId, clock);
    expect((await fetch(`${app.base}${MCP_PATHS.approvals}`, { method: 'POST', headers: { authorization }, body })).status).toBe(401);
  });

  test('an agent whose key row moved organization is refused', async () => {
    await held.db.update(agents).set({ owner: STRANGER }).where(eq(agents.id, agent.row.agent));
    const res = await post(agent, MCP_PATHS.approvals, {});
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: 'agent_key_missing' });
  });
});

describe('POST /v1/token', () => {
  test('sets the hash of the signing agent, and the new token replaces the old one', async () => {
    const token = newToken();
    const res = await post(agent, MCP_PATHS.token, { tokenHash: tokenHashOf(token) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect((await held.db.select().from(agentKeys).where(eq(agentKeys.agent, agent.row.agent)))[0]?.mcpTokenHash).toBe(tokenHashOf(token));
    expect((await rpc(app, token, { jsonrpc: '2.0', id: 1, method: 'ping' })).status).toBe(200);
    expect((await rpc(app, agent.token, { jsonrpc: '2.0', id: 1, method: 'ping' })).status).toBe(401);
  });

  test('refuses a malformed hash and a hash another agent holds', async () => {
    expect((await post(agent, MCP_PATHS.token, { tokenHash: 'short' })).status).toBe(400);
    expect((await post(agent, MCP_PATHS.token, { tokenHash: tokenHashOf(other.token) })).status).toBe(409);
  });
});

describe('POST /v1/approvals', () => {
  test('answers at once with the pending requests, named by connector key', async () => {
    const id = await pending(agent);
    await pending(other);
    const res = await post(agent, MCP_PATHS.approvals, {});
    expect(res.status).toBe(200);
    const list = mcpApprovalsOf(await res.json());
    expect(list).toEqual([{ id, connector: 'notion', tool: 'update_page', preview: '{"page":1}', requestedAt: clock }]);
  });

  test('holds while nothing is pending, and wakes when a request arrives', async () => {
    const started = Date.now();
    const empty = await post(agent, MCP_PATHS.approvals, {});
    expect(mcpApprovalsOf(await empty.json())).toEqual([]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    const waiting = post(agent, MCP_PATHS.approvals, {});
    await Bun.sleep(30);
    const id = await pending(agent);
    app.deps.waiters.notify(agent.row.agent);
    expect(mcpApprovalsOf(await (await waiting).json()).map((row) => row.id)).toEqual([id]);
  });

  test('a delivered request is not sent again at once, but is re-delivered a minute later while still pending', async () => {
    const id = await pending(agent);
    expect(mcpApprovalsOf(await (await post(agent, MCP_PATHS.approvals, {})).json()).map((row) => row.id)).toEqual([id]);
    expect(mcpApprovalsOf(await (await post(agent, MCP_PATHS.approvals, {})).json())).toEqual([]);
    clock += REDELIVER_MS + 1;
    expect(mcpApprovalsOf(await (await post(agent, MCP_PATHS.approvals, {})).json()).map((row) => row.id)).toEqual([id]);
  });
});

describe('POST /v1/approvals/answer', () => {
  test('moves a pending request to allow or deny, once', async () => {
    const id = await pending(agent);
    expect((await post(agent, MCP_PATHS.answer, { id, decision: 'allow' })).status).toBe(200);
    expect((await held.db.select().from(mcpApprovals).where(eq(mcpApprovals.id, id)))[0]).toMatchObject({ state: 'allow', answeredAt: clock });
    expect((await post(agent, MCP_PATHS.answer, { id, decision: 'deny' })).status).toBe(404);
  });

  test('an unknown id, another agent\'s request or a bad decision is refused', async () => {
    const theirs = await pending(other);
    expect((await post(agent, MCP_PATHS.answer, { id: 'zzzzz', decision: 'allow' })).status).toBe(404);
    expect((await post(agent, MCP_PATHS.answer, { id: theirs, decision: 'allow' })).status).toBe(404);
    expect((await post(agent, MCP_PATHS.answer, { id: theirs, decision: 'maybe' })).status).toBe(400);
  });
});
