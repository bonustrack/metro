import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomInt } from 'node:crypto';
import { eq, sql, type SQL } from 'drizzle-orm';
import { AGENT_TOKENS_MAX, findAgentToken, tokenHashOf } from '@metro-labs/connectors/db/agent-tokens';
import { agentKeyStore, leaveOrganization } from '@metro-labs/connectors/db/agent-keys';
import { APPROVAL_TTL_MS, approvalStore } from '@metro-labs/connectors/db/mcp-approvals';
import { handleRemoteAgentsRequest } from '../src/agents/remote-api.ts';
import { agents, agentTokens, connectorAgents, connectors, mcpApprovals } from '../src/db/schema.ts';
import { newEnrolledAgent } from './connector-agent-fixture.ts';
import { auth, testKeys, TEST_OWNER, TEST_STRANGER } from './identity-helper.ts';
import { addAgent, addRemoteAgent, PGLITE_START_MS, PGLITE_STEP_MS, testDb, type TestDb } from './pglite-db.ts';

const REMOTE = 'remote00001';
const BOX = 'agent000001';
const THEIRS = 'remote00002';
const CONN = 'conn0000001';
const NOW = Date.parse('2026-10-23T09:00:00.000Z');

let held: TestDb;
let server: Server;
let base = '';
let now = NOW;

interface TokenView { id: string; label: string; createdAt: number; lastUsedAt: number | null; revokedAt: number | null }

async function call(path: string, init: { method?: string; body?: unknown; who?: string; role?: 'admin' | 'member' } = {}): Promise<Response> {
  const headers: Record<string, string> = { authorization: await auth(init.who ?? TEST_OWNER, init.role ?? 'admin') };
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  return fetch(`${base}${path}`, { method: init.method ?? 'GET', headers, ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }) });
}

async function created(agent = REMOTE, label = 'Claude Code'): Promise<{ token: TokenView; key: string }> {
  const res = await call(`/api/agents/${agent}/tokens`, { method: 'POST', body: { label } });
  expect(res.status).toBe(201);
  return (await res.json()) as { token: TokenView; key: string };
}

const tokensOf = async (agent = REMOTE, who = TEST_OWNER, role: 'admin' | 'member' = 'admin'): Promise<Response> => call(`/api/agents/${agent}/tokens`, { who, role });

async function refused(query: SQL): Promise<boolean> {
  try {
    await held.db.execute(query);
    return false;
  } catch {
    return true;
  }
}

async function pendingApproval(agent = REMOTE, owner = TEST_OWNER, args = '{"title":"Plan"}'): Promise<string> {
  return approvalStore(() => held.db).request({ agent, owner }, { connector: CONN, tool: 'create_page', digest: `digest-${args.length}`.padEnd(43, 'x'), preview: args }, now);
}

beforeAll(async () => {
  held = await testDb();
  const keys = await testKeys();
  server = createServer((req, res) => {
    if (!handleRemoteAgentsRequest(req, res, { keys, db: () => held.db, now: () => now })) res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => {
    server.listen(randomInt(10_000, 30_000), '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
}, PGLITE_START_MS);

beforeEach(async () => {
  now = NOW;
  await held.reset();
  await addRemoteAgent(held.db, REMOTE, TEST_OWNER, 'Claude on my laptop');
  await addAgent(held.db, BOX, TEST_OWNER);
  await addRemoteAgent(held.db, THEIRS, TEST_STRANGER, 'Theirs');
  const at = '2026-10-20T00:00:00.000Z';
  await held.db.insert(connectors).values({ id: CONN, owner: TEST_OWNER, name: 'Notion', url: 'https://mcp.notion.com', auth: 'header', createdBy: 'user_01TEST', createdAt: at, updatedAt: at });
  await held.db.insert(connectorAgents).values({ connector: CONN, agent: REMOTE, createdBy: 'user_01TEST', createdAt: at });
}, PGLITE_STEP_MS);

afterAll(async () => {
  server.close();
  await held.close();
});

describe('agents without a server in the database', () => {
  test('an existing agent is a box, and only a remote agent may have no address', async () => {
    const rows = await held.db.select({ id: agents.id, kind: agents.kind, host: agents.host }).from(agents).where(eq(agents.owner, TEST_OWNER)).orderBy(agents.id);
    expect(rows).toEqual([{ id: BOX, kind: 'box', host: `${BOX}.tail0000.ts.net` }, { id: REMOTE, kind: 'remote', host: null }]);
    expect(await refused(sql`INSERT INTO agents (id, owner, host, added_at) VALUES ('nohost00001', ${TEST_OWNER}, NULL, 'x')`)).toBe(true);
    expect(await refused(sql`INSERT INTO agents (id, owner, kind, host, added_at) VALUES ('withhost001', ${TEST_OWNER}, 'remote', 'a.ts.net', 'x')`)).toBe(true);
    expect(await refused(sql`INSERT INTO agents (id, owner, kind, host, added_at) VALUES ('oddkind0001', ${TEST_OWNER}, 'cloud', NULL, 'x')`)).toBe(true);
    expect(await refused(sql`INSERT INTO agents (id, owner, kind, host, added_at) VALUES ('fine0000001', ${TEST_OWNER}, 'remote', NULL, 'x')`)).toBe(false);
  });

  test('no server can enroll as an agent without a server', async () => {
    const enroll = agentKeyStore(() => held.db).enroll(newEnrolledAgent(REMOTE, TEST_OWNER).row);
    expect(enroll).rejects.toThrow('This agent has no server, so no server can enroll as it.');
    await enroll.catch(() => undefined);
    await agentKeyStore(() => held.db).enroll(newEnrolledAgent(BOX, TEST_OWNER).row);
    const stray = newEnrolledAgent(REMOTE, TEST_OWNER).row;
    await held.db.execute(sql`INSERT INTO agent_keys (agent, owner, key_id, signing_key, enrolled_by, enrolled_at) VALUES (${stray.agent}, ${stray.owner}, ${stray.keyId}, ${stray.signingKey}, ${stray.enrolledBy}, ${stray.enrolledAt})`);
    expect(await agentKeyStore(() => held.db).find(stray.keyId)).toBeNull();
  });

  test('two remote agents of one organization both keep no address', async () => {
    await addRemoteAgent(held.db, 'remote00003', TEST_OWNER, 'Second');
    expect(await held.db.$count(agents, eq(agents.kind, 'remote'))).toBe(3);
    expect(await held.db.$count(agents, eq(agents.owner, TEST_OWNER))).toBe(3);
  });
});

describe('access keys', () => {
  test('an admin creates a key: the answer carries it once, the database only its hash', async () => {
    const made = await created();
    expect(made.key).toMatch(/^mcp_[A-Za-z0-9_-]{43}$/);
    expect(made.token).toMatchObject({ label: 'Claude Code', lastUsedAt: null, revokedAt: null });
    const rows = await held.db.select().from(agentTokens);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tokenHash).toBe(tokenHashOf(made.key));
    expect(JSON.stringify(rows)).not.toContain(made.key);
    const listed = (await (await tokensOf(REMOTE, TEST_OWNER, 'member')).json()) as { tokens: TokenView[] };
    expect(listed.tokens).toEqual([made.token]);
    expect(JSON.stringify(listed)).not.toContain('mcp_');
  });

  test('a member reads the keys but cannot create or revoke one', async () => {
    const made = await created();
    expect((await call(`/api/agents/${REMOTE}/tokens`, { method: 'POST', body: { label: 'x' }, role: 'member' })).status).toBe(403);
    expect((await call(`/api/agents/${REMOTE}/tokens/${made.token.id}`, { method: 'DELETE', role: 'member' })).status).toBe(403);
    expect((await tokensOf(REMOTE, TEST_OWNER, 'member')).status).toBe(200);
  });

  test('another organization sees no agent, so it can neither list, create nor revoke', async () => {
    const made = await created();
    expect((await tokensOf(REMOTE, TEST_STRANGER)).status).toBe(404);
    expect((await call(`/api/agents/${REMOTE}/tokens`, { method: 'POST', body: { label: 'x' }, who: TEST_STRANGER })).status).toBe(404);
    expect((await call(`/api/agents/${REMOTE}/tokens/${made.token.id}`, { method: 'DELETE', who: TEST_STRANGER })).status).toBe(404);
    expect((await call(`/api/agents/${THEIRS}/tokens`, { method: 'POST', body: { label: 'x' } })).status).toBe(404);
    expect(await findAgentToken(held.db, tokenHashOf(made.key))).toEqual({ agent: REMOTE, owner: TEST_OWNER, tokenId: made.token.id, remote: true });
  });

  test('a revoked key stays listed as revoked and no longer names its agent', async () => {
    const made = await created();
    now += 5_000;
    const res = await call(`/api/agents/${REMOTE}/tokens/${made.token.id}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { token: TokenView }).token.revokedAt).toBe(now);
    expect(await findAgentToken(held.db, tokenHashOf(made.key))).toBeNull();
    expect((await call(`/api/agents/${REMOTE}/tokens/${made.token.id}`, { method: 'DELETE' })).status).toBe(200);
    expect((await call(`/api/agents/${REMOTE}/tokens/nosuchkey00`, { method: 'DELETE' })).status).toBe(404);
  });

  test('a key needs a name, and an agent holds at most 20 live keys', async () => {
    expect((await call(`/api/agents/${REMOTE}/tokens`, { method: 'POST', body: { label: '  ' } })).status).toBe(400);
    expect((await call(`/api/agents/${REMOTE}/tokens`, { method: 'POST', body: { label: 'x'.repeat(65) } })).status).toBe(400);
    const first = await created(REMOTE, 'key 1');
    for (let n = 2; n <= AGENT_TOKENS_MAX; n += 1) await created(REMOTE, `key ${String(n)}`);
    expect((await call(`/api/agents/${REMOTE}/tokens`, { method: 'POST', body: { label: 'one more' } })).status).toBe(409);
    await call(`/api/agents/${REMOTE}/tokens/${first.token.id}`, { method: 'DELETE' });
    await created(REMOTE, 'one more');
  });

  test('an agent with a server gets access keys too, which a move drops and a delete removes', async () => {
    const made = await created(BOX, 'Laptop');
    expect(await findAgentToken(held.db, tokenHashOf(made.key))).toEqual({ agent: BOX, owner: TEST_OWNER, tokenId: made.token.id, remote: false });
    expect((await (await tokensOf(BOX, TEST_OWNER, 'member')).json()) as { tokens: TokenView[] }).toEqual({ tokens: [made.token] });
    expect((await call(`/api/agents/${BOX}/tokens`, { method: 'POST', body: { label: 'x' }, role: 'member' })).status).toBe(403);
    await held.db.transaction((tx) => leaveOrganization(tx, BOX));
    expect(await findAgentToken(held.db, tokenHashOf(made.key))).toBeNull();
    const again = await created(BOX, 'Again');
    await held.db.delete(agents).where(eq(agents.id, BOX));
    expect(await findAgentToken(held.db, tokenHashOf(again.key))).toBeNull();
    expect(await held.db.$count(agentTokens)).toBe(0);
  });

  test('deleting the agent deletes its keys, and moving it out of the organization drops them', async () => {
    const made = await created();
    await held.db.transaction((tx) => leaveOrganization(tx, REMOTE));
    expect(await findAgentToken(held.db, tokenHashOf(made.key))).toBeNull();
    const again = await created();
    await held.db.delete(agents).where(eq(agents.id, REMOTE));
    expect(await held.db.$count(agentTokens)).toBe(0);
    expect(await findAgentToken(held.db, tokenHashOf(again.key))).toBeNull();
  });

  test('a key whose agent moved to another organization no longer names it', async () => {
    const made = await created();
    await held.db.update(agents).set({ owner: TEST_STRANGER }).where(eq(agents.id, REMOTE));
    expect(await findAgentToken(held.db, tokenHashOf(made.key))).toBeNull();
  });
});

describe('approvals answered on metro.box', () => {
  test('a member lists what waits, with the connector key the agent sees', async () => {
    const id = await pendingApproval();
    const res = await call(`/api/agents/${REMOTE}/approvals`, { role: 'member' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ approvals: [{ id, connector: CONN, connectorKey: 'notion', connectorName: 'Notion', connectorUrl: 'https://mcp.notion.com', tool: 'create_page', preview: '{"title":"Plan"}', requestedAt: NOW }] });
  });

  test('a member answers once, as on a box page, which moves the row as the daemon relay does', async () => {
    const id = await pendingApproval();
    expect((await call(`/api/agents/${REMOTE}/approvals/${id}`, { method: 'POST', body: { decision: 'maybe' }, role: 'member' })).status).toBe(400);
    expect((await call(`/api/agents/${REMOTE}/approvals/${id}`, { method: 'POST', body: { decision: 'allow' }, role: 'member' })).status).toBe(200);
    const row = (await held.db.select().from(mcpApprovals).where(eq(mcpApprovals.id, id)))[0];
    expect(row).toMatchObject({ state: 'allow', answeredAt: NOW });
    expect((await call(`/api/agents/${REMOTE}/approvals/${id}`, { method: 'POST', body: { decision: 'deny' } })).status).toBe(404);
    expect(((await (await call(`/api/agents/${REMOTE}/approvals`)).json()) as { approvals: unknown[] }).approvals).toEqual([]);
    const request = { connector: CONN, tool: 'create_page', digest: `digest-${'{"title":"Plan"}'.length}`.padEnd(43, 'x'), preview: '' };
    expect(await approvalStore(() => held.db).redeem({ agent: REMOTE, owner: TEST_OWNER }, id, request, NOW + 60_000)).toBe('used');
    expect(await approvalStore(() => held.db).redeem({ agent: REMOTE, owner: TEST_OWNER }, id, request, NOW + 60_000)).toBe('invalid');
  });

  test('a denial is kept, so the agent is told not to repeat the call', async () => {
    const id = await pendingApproval();
    expect((await call(`/api/agents/${REMOTE}/approvals/${id}`, { method: 'POST', body: { decision: 'deny' } })).status).toBe(200);
    const request = { connector: CONN, tool: 'create_page', digest: `digest-${'{"title":"Plan"}'.length}`.padEnd(43, 'x'), preview: '' };
    expect(await approvalStore(() => held.db).redeem({ agent: REMOTE, owner: TEST_OWNER }, id, request, NOW)).toBe('denied');
  });

  test('a request older than 24 hours expires and can no longer be answered, and listing it writes nothing', async () => {
    const id = await pendingApproval();
    now = NOW + APPROVAL_TTL_MS + 1;
    expect(((await (await call(`/api/agents/${REMOTE}/approvals`)).json()) as { approvals: unknown[] }).approvals).toEqual([]);
    expect((await held.db.select().from(mcpApprovals).where(eq(mcpApprovals.id, id)))[0]?.state).toBe('pending');
    expect((await call(`/api/agents/${REMOTE}/approvals/${id}`, { method: 'POST', body: { decision: 'allow' } })).status).toBe(404);
  });

  test('another organization and an agent with a server are refused', async () => {
    const id = await pendingApproval();
    expect((await call(`/api/agents/${REMOTE}/approvals`, { who: TEST_STRANGER })).status).toBe(404);
    expect((await call(`/api/agents/${REMOTE}/approvals/${id}`, { method: 'POST', body: { decision: 'allow' }, who: TEST_STRANGER })).status).toBe(404);
    expect((await call(`/api/agents/${BOX}/approvals`)).status).toBe(409);
    const theirs = await pendingApproval(THEIRS, TEST_STRANGER);
    expect((await call(`/api/agents/${REMOTE}/approvals/${theirs}`, { method: 'POST', body: { decision: 'allow' } })).status).toBe(404);
    expect((await held.db.select().from(mcpApprovals).where(eq(mcpApprovals.id, theirs)))[0]?.state).toBe('pending');
  });

  test('an unknown path or method under the agent is answered plainly', async () => {
    expect((await call('/api/agents/not-an-id/tokens')).status).toBe(404);
    expect((await call(`/api/agents/${REMOTE}/approvals`, { method: 'DELETE' })).status).toBe(405);
    expect((await call(`/api/agents/${REMOTE}/tokens/abc`, { method: 'POST', body: {} })).status).toBe(405);
  });
});
