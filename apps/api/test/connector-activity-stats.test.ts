import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import type { NewMcpCall } from '@metro-labs/connectors/db/mcp-calls';
import { connectors, mcpCalls } from '../src/db/schema.ts';
import { auth, TEST_OWNER, TEST_STRANGER } from './identity-helper.ts';
import { addAgent, PGLITE_START_MS, PGLITE_STEP_MS, testDb, type TestDb } from './pglite-db.ts';
import { startApi, type Api } from './org-connectors-fixture.ts';

const OURS = 'agent000001';
const SECOND = 'agent000002';
const THEIRS = 'agent000003';
const NOTION = 'conn0000001';
const LINEAR = 'conn0000002';
const FOREIGN = 'conn0000003';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.parse('2026-10-22T09:30:00.000Z');

let held: TestDb;
let api: Api;
let serial = 0;

interface Count {
  total: number;
  failed: number;
}

interface Stats {
  range: string;
  bucketMs: number;
  buckets: (Count & { at: number; byConnector: Record<string, Count> })[];
  connectors: (Count & { key: string; connector?: string; name: string; url?: string })[];
  totals: { total: number; ok: number; failed: number; blocked: number; denied: number; waiting: number; p50Ms: number | null; p95Ms: number | null };
}

const get = async (query = '', authorization?: string): Promise<Response> =>
  fetch(`${api.base}/api/connectors/activity/stats${query}`, { headers: { authorization: authorization ?? (await auth(TEST_OWNER, 'member')) } });

const stats = async (query = '', authorization?: string): Promise<Stats> => {
  const res = await get(query, authorization);
  expect(res.status).toBe(200);
  return (await res.json()) as Stats;
};

function row(patch: Partial<NewMcpCall>): NewMcpCall {
  serial += 1;
  return { id: `call${String(serial).padStart(7, '0')}`, owner: TEST_OWNER, agent: OURS, connector: NOTION, connectorKey: 'notion', connectorName: 'Notion', tool: 'search', outcome: 'ok', ms: 120, at: NOW - 60_000, ...patch };
}

const insert = async (...rows: NewMcpCall[]): Promise<void> => {
  await held.db.insert(mcpCalls).values(rows.map((one) => ({ ...one, agentName: null })));
};

async function addConnector(id: string, owner: string, name: string, url: string): Promise<void> {
  const at = '2026-10-20T00:00:00.000Z';
  await held.db.insert(connectors).values({ id, owner, name, url, auth: 'header', createdBy: 'user_01TEST', createdAt: at, updatedAt: at });
}

const nonEmpty = (answer: Stats): [number, Count][] => answer.buckets.flatMap((bucket, i): [number, Count][] => (bucket.total === 0 ? [] : [[i, { total: bucket.total, failed: bucket.failed }]]));

beforeAll(async () => {
  held = await testDb();
  api = await startApi(() => held.db, () => NOW, () => Promise.reject(new Error('no vendor in this test')));
}, PGLITE_START_MS);

beforeEach(async () => {
  await held.reset();
  await addAgent(held.db, OURS, TEST_OWNER);
  await addAgent(held.db, SECOND, TEST_OWNER);
  await addAgent(held.db, THEIRS, TEST_STRANGER);
  await addConnector(NOTION, TEST_OWNER, 'Notion', 'https://mcp.notion.com');
  await addConnector(LINEAR, TEST_OWNER, 'Linear', 'https://mcp.linear.app');
  await addConnector(FOREIGN, TEST_STRANGER, 'Their Notion', 'https://mcp.notion.com');
}, PGLITE_STEP_MS);

afterAll(async () => {
  await api.close();
  await held.close();
});

describe('who reads the call stats', () => {
  test('a member of the organization reads them, nobody signed out does, and only GET is answered', async () => {
    expect((await fetch(`${api.base}/api/connectors/activity/stats`)).status).toBe(401);
    expect((await stats()).totals.total).toBe(0);
    expect((await stats('', await auth(TEST_OWNER, 'admin'))).totals.total).toBe(0);
    const post = await fetch(`${api.base}/api/connectors/activity/stats`, { method: 'POST', headers: { authorization: await auth(TEST_OWNER) } });
    expect(post.status).toBe(405);
    expect((await fetch(`${api.base}/api/connectors/activity/other`, { headers: { authorization: await auth(TEST_OWNER) } })).status).toBe(404);
  });

  test('an organization never counts the calls of another one, whatever the query names', async () => {
    await insert(row({}), row({ owner: TEST_STRANGER, agent: THEIRS, connector: FOREIGN }), row({ owner: TEST_STRANGER, agent: THEIRS, connector: FOREIGN }));
    expect((await stats()).totals.total).toBe(1);
    expect((await stats(`?owner=${TEST_STRANGER}`)).totals.total).toBe(1);
    expect((await stats(`?agent=${THEIRS}`)).totals.total).toBe(0);
    expect((await stats(`?connector=${FOREIGN}`)).totals.total).toBe(0);
    const theirs = await stats('', await auth(TEST_STRANGER, 'member'));
    expect(theirs.totals.total).toBe(2);
    expect(theirs.connectors).toEqual([{ key: FOREIGN, connector: FOREIGN, name: 'Their Notion', url: 'https://mcp.notion.com', total: 2, failed: 0 }]);
  });
});

describe('buckets', () => {
  test('7 days by default: 28 buckets of 6 hours on UTC boundaries, zero-filled, the last one holding now', async () => {
    const answer = await stats();
    expect(answer.range).toBe('7d');
    expect(answer.bucketMs).toBe(6 * HOUR);
    expect(answer.buckets).toHaveLength(28);
    expect(answer.buckets[0]?.at).toBe(Date.parse('2026-10-15T12:00:00.000Z'));
    expect(answer.buckets.at(-1)?.at).toBe(Date.parse('2026-10-22T06:00:00.000Z'));
    expect(answer.buckets.every((bucket, i) => bucket.at === (answer.buckets[0]?.at ?? 0) + i * 6 * HOUR && bucket.total === 0 && bucket.failed === 0)).toBe(true);
    expect(answer.buckets.every((bucket) => Object.keys(bucket.byConnector).length === 0)).toBe(true);
    expect(answer.totals).toEqual({ total: 0, ok: 0, failed: 0, blocked: 0, denied: 0, waiting: 0, p50Ms: null, p95Ms: null });
  });

  test('24 hours: hourly buckets, a call at a boundary goes to the bucket it starts, older calls are left out', async () => {
    const from = Date.parse('2026-10-21T10:00:00.000Z');
    await insert(
      row({ at: from - 1 }),
      row({ at: from }),
      row({ at: from + HOUR - 1 }),
      row({ at: from + HOUR }),
      row({ at: NOW - 1_000, outcome: 'vendor_error' }),
      row({ at: from + 24 * HOUR - 1 }),
    );
    const answer = await stats('?range=24h');
    expect(answer.bucketMs).toBe(HOUR);
    expect(answer.buckets).toHaveLength(24);
    expect(answer.buckets[0]?.at).toBe(from);
    expect(nonEmpty(answer)).toEqual([[0, { total: 2, failed: 0 }], [1, { total: 1, failed: 0 }], [23, { total: 2, failed: 1 }]]);
    expect(answer.totals.total).toBe(5);
  });

  test('30 and 90 days: daily buckets from UTC midnight', async () => {
    await insert(row({ at: Date.parse('2026-10-22T00:00:00.000Z') }), row({ at: Date.parse('2026-10-01T23:59:59.999Z') }), row({ at: Date.parse('2026-09-01T12:00:00.000Z') }), row({ at: Date.parse('2026-07-01T12:00:00.000Z') }));
    const month = await stats('?range=30d');
    expect(month.bucketMs).toBe(DAY);
    expect(month.buckets).toHaveLength(30);
    expect(month.buckets[0]?.at).toBe(Date.parse('2026-09-23T00:00:00.000Z'));
    expect(nonEmpty(month)).toEqual([[8, { total: 1, failed: 0 }], [29, { total: 1, failed: 0 }]]);
    const quarter = await stats('?range=90d');
    expect(quarter.buckets).toHaveLength(90);
    expect(quarter.buckets[0]?.at).toBe(Date.parse('2026-07-25T00:00:00.000Z'));
    expect(quarter.totals.total).toBe(3);
    expect(nonEmpty(quarter).map(([slot]) => slot)).toEqual([38, 68, 89]);
  });

  test('a range Metro does not know is refused by name', async () => {
    for (const range of ['1h', '7', 'week', '7D']) {
      const res = await get(`?range=${range}`);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain('range');
    }
  });
});

describe('what counts as failed, blocked and waiting', () => {
  test('failed, blocked and waiting each have their outcomes, and the times come from the calls that went to the connector', async () => {
    const outcomes: [string, number][] = [
      ['ok', 100], ['ok', 200], ['ok', 300], ['ok', 400], ['vendor_error', 500], ['unavailable', 600],
      ['blocked', 1], ['denied', 2], ['needs_approval', 3], ['not_found', 4], ['invalid', 5], ['signin', 6], ['something_new', 7],
    ];
    await insert(...outcomes.map(([outcome, ms]) => row({ outcome, ms })));
    const answer = await stats();
    expect(answer.totals).toEqual({ total: 13, ok: 4, failed: 5, blocked: 2, denied: 1, waiting: 1, p50Ms: 350, p95Ms: 575 });
    expect(answer.buckets.at(-1)).toMatchObject({ total: 13, failed: 5, byConnector: { [NOTION]: { total: 13, failed: 5 } } });
    expect(answer.connectors).toEqual([{ key: NOTION, connector: NOTION, name: 'Notion', url: 'https://mcp.notion.com', total: 13, failed: 5 }]);
  });
});

describe('agent and connector filters', () => {
  beforeEach(async () => {
    await insert(
      row({ outcome: 'vendor_error' }),
      row({ agent: SECOND }),
      row({ agent: SECOND, connector: LINEAR, connectorKey: 'linear', connectorName: 'Linear' }),
      row({ connector: null, connectorKey: 'jira', connectorName: null, outcome: 'not_found' }),
    );
  });

  test('agent keeps the calls of one agent of the organization', async () => {
    const answer = await stats(`?agent=${SECOND}`);
    expect(answer.totals.total).toBe(2);
    expect(answer.connectors.map((one) => [one.key, one.total])).toEqual([[NOTION, 1], [LINEAR, 1]]);
  });

  test('connector keeps one connector by its id, or the calls that named the same unknown key', async () => {
    expect((await stats(`?connector=${NOTION}`)).totals).toMatchObject({ total: 2, failed: 1 });
    expect((await stats(`?connector=${LINEAR}&agent=${OURS}`)).totals.total).toBe(0);
    const unknown = await stats('?connector=jira');
    expect(unknown.totals).toMatchObject({ total: 1, failed: 1 });
    expect(unknown.connectors).toEqual([{ key: 'jira', name: 'jira', total: 1, failed: 1 }]);
    expect((await stats('?connector=notion')).totals.total).toBe(0);
  });

  test('a malformed filter is refused by name', async () => {
    for (const [query, name] of [['?agent=nope', 'agent'], ['?connector=a%20b', 'connector'], [`?connector=${'x'.repeat(129)}`, 'connector']] as const) {
      const res = await get(query);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain(name);
    }
  });
});

describe('the connectors breakdown', () => {
  test('the 8 connectors with the most calls, then Other for the rest, in buckets too', async () => {
    const rows = Array.from({ length: 10 }, (_, i) => Array.from({ length: 10 - i }, () => row({ connector: `connector0${String(i)}`, connectorKey: `c${String(i)}`, connectorName: `C${String(i)}`, outcome: i === 9 ? 'unavailable' : 'ok' }))).flat();
    await insert(...rows);
    const answer = await stats();
    expect(answer.connectors.map((one) => [one.key, one.name, one.total, one.failed])).toEqual([
      ...Array.from({ length: 8 }, (_, i) => [`connector0${String(i)}`, `C${String(i)}`, 10 - i, 0]),
      ['~other', 'Other', 3, 1],
    ]);
    expect(answer.connectors.at(-1)?.connector).toBeUndefined();
    const last = answer.buckets.at(-1);
    expect(Object.keys(last?.byConnector ?? {}).sort()).toEqual([...Array.from({ length: 8 }, (_, i) => `connector0${String(i)}`), '~other'].sort());
    expect(last?.byConnector['~other']).toEqual({ total: 3, failed: 1 });
    expect(last).toMatchObject({ total: 55, failed: 1 });
  });

  test('a renamed connector shows its new name, a deleted one keeps the name it had, an unknown key shows the key', async () => {
    await insert(row({}), row({ connector: null, connectorKey: 'jira', connectorName: null, outcome: 'not_found' }));
    await held.db.update(connectors).set({ name: 'Team Notion' }).where(eq(connectors.id, NOTION));
    expect((await stats()).connectors).toEqual([
      { key: NOTION, connector: NOTION, name: 'Team Notion', url: 'https://mcp.notion.com', total: 1, failed: 0 },
      { key: 'jira', name: 'jira', total: 1, failed: 1 },
    ]);
    await held.db.delete(connectors).where(eq(connectors.id, NOTION));
    expect((await stats()).connectors[0]).toEqual({ key: NOTION, connector: NOTION, name: 'Notion', total: 1, failed: 0 });
  });
});
