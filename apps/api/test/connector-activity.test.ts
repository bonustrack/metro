import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { recordCall, type NewMcpCall } from '@metro-labs/connectors/db/mcp-calls';
import { agents, connectors, mcpCalls } from '../src/db/schema.ts';
import { auth, TEST_OWNER, TEST_STRANGER } from './identity-helper.ts';
import { addAgent, PGLITE_START_MS, PGLITE_STEP_MS, testDb, type TestDb } from './pglite-db.ts';
import { startApi, type Api } from './org-connectors-fixture.ts';

const OURS = 'agent000001';
const SECOND = 'agent000002';
const THEIRS = 'agent000003';
const NOTION = 'conn0000001';
const LINEAR = 'conn0000002';
const FOREIGN = 'conn0000003';
const NOW = Date.parse('2026-10-22T09:00:00.000Z');

let held: TestDb;
let api: Api;
let serial = 0;

interface Call {
  id: string;
  agent: string;
  agentName?: string;
  connector: string | null;
  connectorKey: string;
  connectorName?: string;
  connectorUrl?: string;
  tool: string;
  outcome: string;
  ms: number;
  at: number;
}

const get = async (query = '', authorization?: string): Promise<Response> =>
  fetch(`${api.base}/api/connectors/activity${query}`, { headers: { authorization: authorization ?? (await auth(TEST_OWNER, 'member')) } });

const calls = async (query = '', authorization?: string): Promise<Call[]> => {
  const res = await get(query, authorization);
  expect(res.status).toBe(200);
  return ((await res.json()) as { calls: Call[] }).calls;
};

function row(patch: Partial<NewMcpCall>): NewMcpCall {
  serial += 1;
  return { id: `call${String(serial).padStart(7, '0')}`, owner: TEST_OWNER, agent: OURS, connector: NOTION, connectorKey: 'notion', connectorName: 'Notion', tool: 'search', outcome: 'ok', ms: 120, at: NOW, ...patch };
}

const record = async (...rows: NewMcpCall[]): Promise<void> => {
  for (const one of rows) await recordCall(held.db, one);
};

async function addConnector(id: string, owner: string, name: string, url: string): Promise<void> {
  const at = '2026-10-20T00:00:00.000Z';
  await held.db.insert(connectors).values({ id, owner, name, url, auth: 'header', createdBy: 'user_01TEST', createdAt: at, updatedAt: at });
}

beforeAll(async () => {
  held = await testDb();
  api = await startApi(() => held.db, () => NOW, () => Promise.reject(new Error('no vendor in this test')));
}, PGLITE_START_MS);

beforeEach(async () => {
  await held.reset();
  await addAgent(held.db, OURS, TEST_OWNER);
  await addAgent(held.db, SECOND, TEST_OWNER);
  await addAgent(held.db, THEIRS, TEST_STRANGER);
  await held.db.update(agents).set({ name: 'Emma' }).where(eq(agents.id, OURS));
  await addConnector(NOTION, TEST_OWNER, 'Notion', 'https://mcp.notion.com');
  await addConnector(LINEAR, TEST_OWNER, 'Linear', 'https://mcp.linear.app');
  await addConnector(FOREIGN, TEST_STRANGER, 'Their Notion', 'https://mcp.notion.com');
}, PGLITE_STEP_MS);

afterAll(async () => {
  await api.close();
  await held.close();
});

describe('who reads the connector activity', () => {
  test('a member of the organization reads it, nobody signed out does, and only GET is answered', async () => {
    expect((await fetch(`${api.base}/api/connectors/activity`)).status).toBe(401);
    expect(await calls()).toEqual([]);
    expect(await calls('', await auth(TEST_OWNER, 'admin'))).toEqual([]);
    const post = await fetch(`${api.base}/api/connectors/activity`, { method: 'POST', headers: { authorization: await auth(TEST_OWNER) } });
    expect(post.status).toBe(405);
  });

  test('an organization never sees the calls of another one, whatever the query names', async () => {
    await record(row({ id: 'callours001' }), row({ id: 'calltheirs1', owner: TEST_STRANGER, agent: THEIRS, connector: FOREIGN }));
    expect((await calls()).map((call) => call.id)).toEqual(['callours001']);
    expect((await calls(`?owner=${TEST_STRANGER}`)).map((call) => call.id)).toEqual(['callours001']);
    expect(await calls(`?agent=${THEIRS}`)).toEqual([]);
    expect((await calls('', await auth(TEST_STRANGER, 'member'))).map((call) => call.id)).toEqual(['calltheirs1']);
  });
});

describe('what the activity answers', () => {
  test('one row per call, newest first, with the current agent and connector names and nothing else', async () => {
    await record(
      row({ id: 'callfirst01', at: NOW - 3_000 }),
      row({ id: 'callsecond1', agent: SECOND, connector: LINEAR, connectorKey: 'linear', connectorName: 'Linear', tool: 'create_issue', outcome: 'needs_approval', ms: 40, at: NOW - 2_000 }),
      row({ id: 'callthird01', connector: null, connectorKey: 'jira', connectorName: null, tool: 'search', outcome: 'not_found', ms: 3, at: NOW - 1_000 }),
    );
    expect(await calls()).toEqual([
      { id: 'callthird01', agent: OURS, agentName: 'Emma', connector: null, connectorKey: 'jira', tool: 'search', outcome: 'not_found', ms: 3, at: NOW - 1_000 },
      { id: 'callsecond1', agent: SECOND, agentName: 'agent000002.tail0000.ts.net', connector: LINEAR, connectorKey: 'linear', connectorName: 'Linear', connectorUrl: 'https://mcp.linear.app', tool: 'create_issue', outcome: 'needs_approval', ms: 40, at: NOW - 2_000 },
      { id: 'callfirst01', agent: OURS, agentName: 'Emma', connector: NOTION, connectorKey: 'notion', connectorName: 'Notion', connectorUrl: 'https://mcp.notion.com', tool: 'search', outcome: 'ok', ms: 120, at: NOW - 3_000 },
    ]);
  });

  test('a renamed connector shows its new name, a deleted one keeps the name it had when the call ran', async () => {
    await record(row({ id: 'callnotion1' }));
    await held.db.update(connectors).set({ name: 'Team Notion' }).where(eq(connectors.id, NOTION));
    expect((await calls())[0]).toMatchObject({ connector: NOTION, connectorName: 'Team Notion', connectorUrl: 'https://mcp.notion.com' });
    await held.db.delete(connectors).where(eq(connectors.id, NOTION));
    const [gone] = await calls();
    expect(gone).toMatchObject({ id: 'callnotion1', connector: NOTION, connectorKey: 'notion', connectorName: 'Notion' });
    expect(gone?.connectorUrl).toBeUndefined();
  });

  test('a renamed agent shows its new name, a deleted one keeps its calls and the name it had', async () => {
    await record(row({ id: 'callemma001' }), row({ id: 'callnoname1', agent: SECOND, at: NOW - 1 }));
    await held.db.update(agents).set({ name: 'Lisa' }).where(eq(agents.id, OURS));
    expect((await calls()).map((call) => [call.id, call.agentName])).toEqual([['callemma001', 'Lisa'], ['callnoname1', 'agent000002.tail0000.ts.net']]);
    await held.db.delete(agents).where(eq(agents.id, OURS));
    expect((await calls()).map((call) => [call.id, call.agent, call.agentName])).toEqual([['callemma001', OURS, 'Emma'], ['callnoname1', SECOND, 'agent000002.tail0000.ts.net']]);
  });

  test('an agent moved to another organization keeps its old calls here, with the name it had, and they never show there', async () => {
    await record(row({ id: 'callmoved01' }));
    await held.db.update(agents).set({ owner: TEST_STRANGER, name: 'Renamed there' }).where(eq(agents.id, OURS));
    expect(await calls()).toEqual([expect.objectContaining({ id: 'callmoved01', agent: OURS, agentName: 'Emma' })]);
    expect(await calls('', await auth(TEST_STRANGER, 'member'))).toEqual([]);
  });

  test('the name stored with a call is the agent of the calling organization only', async () => {
    await record(row({ id: 'callspoof01', owner: TEST_STRANGER, agent: OURS }));
    const [stored] = await held.db.select().from(mcpCalls).where(eq(mcpCalls.id, 'callspoof01'));
    expect(stored?.agentName).toBeNull();
  });
});

describe('since, limit and agent', () => {
  test('50 by default, 200 at most, newest first', async () => {
    await held.db.insert(mcpCalls).values(Array.from({ length: 230 }, (_, i) => row({ at: NOW - i * 1_000 })));
    const page = await calls();
    expect(page).toHaveLength(50);
    expect(page[0]?.at).toBe(NOW);
    expect(page.every((call, i) => i === 0 || call.at < (page[i - 1]?.at ?? 0))).toBe(true);
    expect(await calls('?limit=5')).toHaveLength(5);
    expect(await calls('?limit=999')).toHaveLength(200);
    expect(await calls('?limit=0')).toHaveLength(1);
  });

  test('since keeps the calls at or after that time', async () => {
    await record(row({ id: 'callold0001', at: NOW - 10_000 }), row({ id: 'callsame001', at: NOW - 5_000 }), row({ id: 'callnew0001', at: NOW }));
    expect((await calls(`?since=${String(NOW - 5_000)}`)).map((call) => call.id)).toEqual(['callnew0001', 'callsame001']);
    expect(await calls(`?since=${String(NOW + 1)}`)).toEqual([]);
  });

  test('before pages through older calls, newest first, without a gap or a repeat on equal times', async () => {
    await held.db.insert(mcpCalls).values(Array.from({ length: 7 }, (_, i) => row({ id: `callpage00${String(i)}`, at: NOW - Math.floor(i / 2) * 1_000 })));
    const first = await calls('?limit=3');
    const last = first.at(-1);
    const second = await calls(`?limit=3&before=${String(last?.at)}:${String(last?.id)}`);
    const tail = second.at(-1);
    const third = await calls(`?limit=3&before=${String(tail?.at)}:${String(tail?.id)}`);
    const seen = [...first, ...second, ...third].map((call) => call.id);
    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
    expect([...first, ...second, ...third].every((call, i, all) => i === 0 || call.at <= (all[i - 1]?.at ?? 0))).toBe(true);
    expect((await calls(`?before=${String(NOW - 1_000)}`)).map((call) => call.at)).toEqual([NOW - 2_000, NOW - 2_000, NOW - 3_000]);
  });

  test('agent keeps one agent of the organization', async () => {
    await record(row({ id: 'callemma001' }), row({ id: 'callother01', agent: SECOND }));
    expect((await calls(`?agent=${SECOND}`)).map((call) => call.id)).toEqual(['callother01']);
  });

  test('connector keeps one connector by its id, or the calls that named the same unknown key, with agent too', async () => {
    await record(
      row({ id: 'callnotion1' }),
      row({ id: 'calllinear1', connector: LINEAR, connectorKey: 'linear', connectorName: 'Linear', at: NOW - 1 }),
      row({ id: 'calllinear2', agent: SECOND, connector: LINEAR, connectorKey: 'linear', connectorName: 'Linear', at: NOW - 2 }),
      row({ id: 'calljira001', connector: null, connectorKey: 'jira', connectorName: null, outcome: 'not_found', at: NOW - 3 }),
    );
    expect((await calls(`?connector=${LINEAR}`)).map((call) => call.id)).toEqual(['calllinear1', 'calllinear2']);
    expect((await calls(`?connector=${LINEAR}&agent=${SECOND}`)).map((call) => call.id)).toEqual(['calllinear2']);
    expect((await calls('?connector=jira')).map((call) => call.id)).toEqual(['calljira001']);
    expect(await calls('?connector=linear')).toEqual([]);
    expect(await calls(`?connector=${FOREIGN}`)).toEqual([]);
  });

  test('a malformed value is refused by name', async () => {
    for (const [query, name] of [['?since=yesterday', 'since'], ['?limit=-3', 'limit'], ['?since=1.5', 'since'], ['?agent=nope', 'agent'], ['?before=soon', 'before'], ['?before=12:short', 'before'], ['?connector=a%20b', 'connector']] as const) {
      const res = await get(query);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain(name);
    }
  });
});
