import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { recordModelCalls, saveModelWindows, type NewModelCall } from '@metro-labs/connectors/db/model-calls';
import { modelConnections } from '../src/db/schema.ts';
import { auth, TEST_OWNER, TEST_STRANGER } from './identity-helper.ts';
import { addAgent, addRemoteAgent, PGLITE_START_MS, testDb, type TestDb } from './pglite-db.ts';
import { provider, startApi, type Api, type Provider } from './org-models-fixture.ts';

const NOW = Date.parse('2026-10-26T12:30:00.000Z');
const HOUR = 3_600_000;
const BOX = 'agent000001';
const DASHBOARD = 'remote00001';
const CLAUDE = 'conn0000001';
const ROUTER = 'conn0000002';

let held: TestDb;
let api: Api;
let vendor: Provider;
let serial = 0;

const call = (over: Partial<NewModelCall> = {}): NewModelCall => ({
  id: `call${String((serial += 1)).padStart(7, '0')}`,
  owner: TEST_OWNER,
  agent: BOX,
  origin: 'box',
  token: null,
  lane: 'main',
  kind: 'main',
  connection: CLAUDE,
  provider: 'anthropic',
  model: 'claude-sonnet-5-5',
  attempt: 0,
  outcome: 'ok',
  status: 200,
  inputTokens: 10,
  outputTokens: 20,
  cacheReadTokens: 1000,
  cacheWrite5mTokens: 5,
  cacheWrite1hTokens: 7,
  costMicros: 1500,
  ms: 2000,
  firstTokenMs: 400,
  at: NOW - HOUR,
  ...over,
});

const usage = async (query = '', authorization?: string): Promise<Response> =>
  fetch(`${api.base}/api/models/usage${query}`, { headers: { authorization: authorization ?? (await auth(TEST_OWNER, 'member')) } });

beforeAll(async () => {
  held = await testDb();
  vendor = provider();
  api = await startApi(() => held.db, () => NOW, vendor.fetch);
}, PGLITE_START_MS);

beforeEach(async () => {
  await held.reset();
  await addAgent(held.db, BOX, TEST_OWNER);
  await addRemoteAgent(held.db, DASHBOARD, TEST_OWNER, 'Dashboard');
  const at = '2026-10-26T00:00:00.000Z';
  await held.db.insert(modelConnections).values([
    { id: CLAUDE, owner: TEST_OWNER, provider: 'anthropic', label: 'Anthropic team', createdBy: 'user', createdAt: at, updatedAt: at },
    { id: ROUTER, owner: TEST_OWNER, provider: 'openrouter', label: 'OpenRouter', createdBy: 'user', createdAt: at, updatedAt: at },
  ]);
  await recordModelCalls(held.db, [
    call(),
    call({ at: NOW - 2 * HOUR, costMicros: 500 }),
    call({ agent: DASHBOARD, origin: 'key', token: 'tok00000001', kind: 'external', connection: ROUTER, provider: 'openrouter', costMicros: 9000, firstTokenMs: 900 }),
    call({ outcome: 'rate_limited', status: 429, costMicros: null, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, firstTokenMs: null }),
    call({ outcome: 'provider_error', status: 502, costMicros: null, firstTokenMs: null }),
    call({ costMicros: null }),
    call({ connection: null, provider: null, model: '', outcome: 'no_route', status: 503, costMicros: null, firstTokenMs: null }),
    call({ at: NOW - 30 * 24 * HOUR }),
    call({ owner: TEST_STRANGER }),
  ]);
});

afterAll(async () => {
  await api.close();
  await held.close();
});

interface Answer {
  range: string;
  bucketMs: number;
  buckets: { at: number; calls: number; failed: number; spendMicros: number; byConnection: Record<string, { calls: number; spendMicros: number }> }[];
  connections: { connection: string; label: string | null; calls: number; spendMicros: number; unpriced: number; cacheWriteTokens: number }[];
  agents: { agent: string; name: string | null; calls: number; spendMicros: number }[];
  totals: Record<string, number | null>;
}

describe('the organization model usage', () => {
  test('a member reads seven days by default: totals, spend by account, by agent, and per 6-hour bucket', async () => {
    const res = await usage();
    expect(res.status).toBe(200);
    const body = (await res.json()) as Answer;
    expect(body.range).toBe('7d');
    expect(body.buckets).toHaveLength(28);
    expect(body.totals).toMatchObject({ calls: 7, ok: 4, failed: 2, limited: 1, spendMicros: 11_000, unpriced: 1, cacheReadTokens: 6000, cacheWriteTokens: 72 });
    expect(body.totals.p50FirstTokenMs).toBe(400);
    expect(body.connections.map((c) => [c.connection, c.label, c.calls, c.spendMicros])).toEqual([
      [ROUTER, 'OpenRouter', 1, 9000],
      [CLAUDE, 'Anthropic team', 5, 2000],
      ['', null, 1, 0],
    ]);
    expect(body.agents.map((a) => [a.agent, a.name, a.calls, a.spendMicros])).toEqual([
      [DASHBOARD, 'Dashboard', 1, 9000],
      [BOX, `${BOX}.tail0000.ts.net`, 6, 2000],
    ]);
    expect(body.buckets.reduce((sum, b) => sum + b.spendMicros, 0)).toBe(11_000);
    const hourAgo = body.buckets.find((b) => b.at <= NOW - HOUR && NOW - HOUR < b.at + body.bucketMs);
    expect(hourAgo?.byConnection[ROUTER]).toEqual({ calls: 1, spendMicros: 9000 });
  });

  test('a range of 90 days reaches the older call, and filters keep one agent or one account', async () => {
    expect(((await (await usage('?range=90d')).json()) as Answer).totals.calls).toBe(8);
    expect(((await (await usage(`?agent=${DASHBOARD}`)).json()) as Answer).totals).toMatchObject({ calls: 1, spendMicros: 9000 });
    expect(((await (await usage(`?connection=${CLAUDE}`)).json()) as Answer).totals).toMatchObject({ calls: 5, spendMicros: 2000 });
  });

  test('the usage windows the gateway saved are listed for the organization only', async () => {
    await saveModelWindows(held.db, TEST_OWNER, CLAUDE, [{ label: '5-hour window', used: 0.5, resetAt: NOW + HOUR, detail: null }], NOW);
    await saveModelWindows(held.db, TEST_STRANGER, 'conn0000099', [{ label: '5-hour window', used: 1, resetAt: null, detail: null }], NOW);
    const res = await fetch(`${api.base}/api/models/windows`, { headers: { authorization: await auth(TEST_OWNER, 'member') } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ windows: [{ connection: CLAUDE, label: '5-hour window', used: 0.5, resetAt: NOW + HOUR, detail: null, at: NOW }] });
  });

  test('bad filters are 400, no session is 401, and another organization sees only its own calls', async () => {
    expect((await usage('?range=1y')).status).toBe(400);
    expect((await usage('?agent=x')).status).toBe(400);
    expect((await usage('?connection=x')).status).toBe(400);
    expect((await fetch(`${api.base}/api/models/usage`)).status).toBe(401);
    const theirs = (await (await usage('', await auth(TEST_STRANGER, 'member'))).json()) as Answer;
    expect(theirs.totals.calls).toBe(1);
  });
});
