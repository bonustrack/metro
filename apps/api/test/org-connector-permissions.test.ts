import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { connectors } from '../src/db/schema.ts';
import type { ConnectorView } from '../src/connectors/model.ts';
import { auth, TEST_OWNER, TEST_STRANGER } from './identity-helper.ts';
import { addAgent, PGLITE_START_MS, PGLITE_STEP_MS, testDb, type TestDb } from './pglite-db.ts';
import { GOOD_KEY, startApi, startVendor, type Api, type Vendor } from './org-connectors-fixture.ts';

const AGENT = 'agent000001';
let held: TestDb;
let vendor: Vendor;
let api: Api;
let now = Date.parse('2026-10-12T05:00:00.000Z');
const call = async (method: string, path: string, body?: unknown, authorization?: string): Promise<Response> => fetch(`${api.base}/api/connectors${path}`, {
  method, headers: { authorization: authorization ?? await auth(TEST_OWNER), 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
});
const view = async (response: Response): Promise<ConnectorView> => { expect(response.status).toBe(200); return await response.json() as ConnectorView; };
async function add(): Promise<ConnectorView> {
  const response = await call('POST', '', { name: 'Same name', url: `${vendor.base}/keyed`, value: GOOD_KEY });
  expect(response.status).toBe(201);
  return (await response.json() as { connector: ConnectorView }).connector;
}

beforeAll(async () => {
  held = await testDb();
  vendor = await startVendor();
  api = await startApi(() => held.db, () => now, vendor.fetch);
}, PGLITE_START_MS);
beforeEach(async () => { now += 60_000; await held.reset(); await addAgent(held.db, AGENT, TEST_OWNER); }, PGLITE_STEP_MS);
afterAll(async () => { await api.close(); await vendor.close(); await held.close(); });

describe('organization and agent connector permissions', () => {
  test('saves full independent policies while preserving identities, names and assignment provenance', async () => {
    const first = await add();
    const second = await add();
    const policy = { read: 'ask', write: 'deny', tools: { special: 'allow', absent: 'deny' } } as const;
    const assignment = { write: 'ask', tools: { special: 'deny' } } as const;
    expect((await view(await call('PUT', `/${first.id}`, { policy }))).policy).toEqual(policy);
    const assigned = await view(await call('PUT', `/${first.id}/agents/${AGENT}/policy`, { policy: assignment }));
    expect(assigned.agents[0]?.policy).toEqual(assignment);
    const savedAt = assigned.agents[0]?.assignedAt;
    now += 10_000;
    const same = await view(await call('PUT', `/${first.id}/agents/${AGENT}`, {}));
    expect(same.agents[0]).toMatchObject({ assignedAt: savedAt, policy: assignment });
    expect((await view(await call('GET', `/${second.id}`))).policy).toEqual({});
    expect((await view(await call('GET', `/${second.id}`))).agents).toEqual([]);
    expect((await view(await call('PUT', `/${first.id}`, { name: 'Renamed' }))).policy).toEqual(policy);
    expect((await view(await call('PUT', `/${first.id}`, { policy: { ...policy, read: 'deny' } }))).agents[0]?.policy).toEqual(assignment);
    expect((await view(await call('PUT', `/${first.id}/agents/${AGENT}/policy`, { policy: {} }))).policy).toEqual({ ...policy, read: 'deny' });
    expect((await view(await call('PUT', `/${first.id}/agents/${AGENT}/policy`, { policy: {} }))).agents[0]?.assignedAt).toBe(savedAt);
  });

  test('legacy switches refuse custom policy and an omitted assignment policy preserves it', async () => {
    const row = await add();
    const custom = { read: 'ask', tools: { removed_tool: 'deny' } };
    await call('PUT', `/${row.id}`, { policy: custom });
    await call('PUT', `/${row.id}/agents/${AGENT}/policy`, { policy: custom });
    expect((await call('PUT', `/${row.id}`, { readOnly: false })).status).toBe(409);
    expect((await call('PUT', `/${row.id}/agents/${AGENT}`, { readOnly: false })).status).toBe(409);
    expect((await view(await call('PUT', `/${row.id}/agents/${AGENT}`, {}))).agents[0]?.policy).toEqual(custom);
    expect((await view(await call('GET', `/${row.id}`))).policy).toEqual(custom);
  });

  test('assignment keeps legacy readOnly behavior and refuses full policy writes on its old route', async () => {
    const row = await add();
    const path = `/${row.id}/agents/${AGENT}`;
    expect((await view(await call('PUT', path, { readOnly: true }))).agents[0]?.policy).toEqual({ write: 'deny' });
    expect((await call('PUT', path, { policy: { write: 'allow' } })).status).toBe(400);
    expect((await view(await call('PUT', path, {}))).agents[0]?.policy).toEqual({ write: 'deny' });
    expect((await view(await call('PUT', path, { readOnly: false }))).agents[0]?.policy).toEqual({});
    for (const body of [{}, { readOnly: true }, { policy: {}, extra: true }]) expect((await call('PUT', `${path}/policy`, body)).status).toBe(400);
    expect((await call('GET', `${path}/policy`)).status).toBe(405);
    expect((await call('DELETE', `${path}/policy`)).status).toBe(405);
    expect((await call('PUT', `${path}/policy/extra`, { policy: {} })).status).toBe(404);
  });

  test('both policy endpoints admit and preserve the maximum named policy size', async () => {
    const row = await add();
    const policy = { read: 'ask', write: 'deny', tools: Object.fromEntries(Array.from({ length: 2000 }, (_, index) => [`a${String(index).padStart(4, '0')}${'x'.repeat(251)}`, 'allow'])) };
    expect(Buffer.byteLength(JSON.stringify({ policy }))).toBeGreaterThan(530_000);
    expect((await view(await call('PUT', `/${row.id}`, { policy }))).policy).toEqual(policy);
    expect((await view(await call('PUT', `/${row.id}/agents/${AGENT}/policy`, { policy }))).agents[0]?.policy).toEqual(policy);
  });

  test('policy APIs are admin-only, scoped to the organization and strict about malformed rules', async () => {
    const row = await add();
    const member = await auth(TEST_OWNER, 'member');
    const stranger = await auth(TEST_STRANGER);
    for (const path of [`/${row.id}`, `/${row.id}/agents/${AGENT}/policy`]) {
      expect((await call('PUT', path, { policy: { write: 'deny' } }, member)).status).toBe(403);
      expect((await call('PUT', path, { policy: {} }, stranger)).status).toBe(404);
      for (const policy of [null, { read: 'ask_first' }, { delete: 'deny' }, { tools: { constructor: 'allow' } }]) {
        expect((await call('PUT', path, { policy })).status).toBe(400);
      }
      expect((await call('PUT', path, { readOnly: true, policy: {} })).status).toBe(400);
    }
    expect((await view(await call('GET', `/${row.id}`, undefined, member))).policy).toEqual({});
    await held.db.update(connectors).set({ policy: 'invalid' }).where(eq(connectors.id, row.id));
    expect((await view(await call('GET', `/${row.id}`))).policy).toEqual({ read: 'deny', write: 'deny' });
  });
});
