import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { newId } from '@metro-labs/core/ids';
import { ApiError } from '@metro-labs/http/api-error';
import { openConnectorSecret, sealConnectorSecret, type ConnectorSecret } from '@metro-labs/connectors/model';
import { openSecret } from '@metro-labs/connectors/secrets';
import type { ConnectorRow } from '@metro-labs/connectors/db/connectors';
import { connectorAgents, connectors, mcpCalls } from '../src/db/schema.ts';
import type { ConnectorView } from '../src/connectors/model.ts';
import { auth, TEST_OWNER, TEST_STRANGER } from './identity-helper.ts';
import { addAgent, PGLITE_START_MS, PGLITE_STEP_MS, testDb, type TestDb } from './pglite-db.ts';
import { startApi, startVendor, type Api, type Vendor } from './org-connectors-fixture.ts';

const TARGET = 'https://vendor.example.com/private-path-fixture?api_key=url-secret-fixture';
const KEY = Buffer.alloc(32, 17);
const AGENT = 'agent000001';
const INPUT = { organization: TEST_STRANGER, name: 'Copied connector', shareCredentials: true };
let held: TestDb;
let vendor: Vendor;
let api: Api;
let now = Date.parse('2026-10-23T03:00:00Z');
let memberships: { id: string; role: string | null }[];
let checkedUsers: string[];

const post = async (id: string, body: unknown = INPUT, authorization?: string): Promise<Response> =>
  fetch(`${api.base}/api/connectors/${id}/copy`, {
    method: 'POST', headers: { authorization: authorization ?? await auth(TEST_OWNER), 'content-type': 'application/json' }, body: JSON.stringify(body),
  });

async function seed(secret: ConnectorSecret = { kind: 'none', targetUrl: TARGET }, change: Partial<ConnectorRow> = {}): Promise<ConnectorRow> {
  const before = '2026-10-22T01:00:00.000Z';
  const row: ConnectorRow = {
    id: newId(), owner: TEST_OWNER, name: 'Source connector', url: 'https://vendor.example.com', auth: secret.kind, authGeneration: newId(), policy: null,
    secret: null, detail: '{"server":"vendor.example.com","verifiedAt":"2026-10-22T01:00:00.000Z"}', createdBy: 'user_original', createdAt: before, updatedAt: before, ...change,
  };
  row.secret = sealConnectorSecret(KEY, row, secret);
  await api.deps.store.create(row);
  return row;
}

async function copied(res: Response): Promise<{ row: ConnectorRow; view: ConnectorView }> {
  expect(res.status).toBe(201);
  const body = await res.json() as { organization: string; connector: ConnectorView };
  expect(body.organization).toBe(TEST_STRANGER);
  const row = await api.deps.store.find(TEST_STRANGER, body.connector.id);
  if (row === null) throw new Error('copy was not stored');
  return { row, view: body.connector };
}

beforeAll(async () => {
  held = await testDb();
  vendor = await startVendor();
  api = await startApi(() => held.db, () => now, vendor.fetch);
}, PGLITE_START_MS);

beforeEach(async () => {
  now += 60_000;
  await held.reset();
  await addAgent(held.db, AGENT, TEST_OWNER);
  api.setKey(KEY);
  memberships = [{ id: TEST_OWNER, role: 'admin' }, { id: TEST_STRANGER, role: 'admin' }];
  checkedUsers = [];
  api.deps.organizations = (user) => { checkedUsers.push(user); return Promise.resolve(memberships); };
  vendor.requests.length = 0;
}, PGLITE_STEP_MS);

afterAll(async () => {
  await api.close();
  await vendor.close();
  await held.close();
});

describe('copying a connector between organizations', () => {
  test('static header credentials and private URLs are resealed under a fresh identity, never returned', async () => {
    const secret: ConnectorSecret = { kind: 'header', targetUrl: TARGET, name: 'Authorization', value: 'Bearer static-secret-fixture' };
    const source = await seed(secret, { policy: '{"read":"ask","write":"deny","tools":{"read_private":"deny","publish":"ask"}}', detail: '{"header":"Authorization","server":"vendor.example.com","verifiedAt":"2026-10-22T01:00:00.000Z","signedInAt":"2026-10-22T01:00:00.000Z"}' });
    await api.deps.store.assign({ owner: TEST_OWNER, connector: source.id, agent: AGENT, policy: '{"read":"deny"}', actor: 'user_original', at: source.createdAt });
    await held.db.insert(mcpCalls).values({ id: newId(), owner: TEST_OWNER, agent: AGENT, agentName: 'Source agent', connector: source.id, connectorKey: 'source', connectorName: source.name, tool: 'read_private', outcome: 'blocked', ms: 0, at: now - 1 });
    const response = await post(source.id, { ...INPUT, name: '  Copied connector  ', owner: 'org_untrusted' });
    const text = await response.clone().text();
    for (const privateValue of ['static-secret-fixture', 'private-path-fixture', 'url-secret-fixture', source.secret ?? 'missing']) expect(text).not.toContain(privateValue);
    const { row, view } = await copied(response);
    expect(checkedUsers).toEqual(['user_01ABC']);
    expect(row).toMatchObject({ owner: TEST_STRANGER, name: 'Copied connector', url: 'https://vendor.example.com', auth: 'header', policy: source.policy, createdBy: 'user_01ABC', createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString() });
    expect(row.id).not.toBe(source.id);
    expect(row.authGeneration).not.toBe(source.authGeneration);
    expect(row.secret).not.toBe(source.secret);
    expect(openConnectorSecret(KEY, row)).toEqual(secret);
    expect(() => openSecret(KEY, TEST_OWNER, row.id, row.secret ?? '')).toThrow();
    expect(() => openSecret(KEY, TEST_STRANGER, source.id, row.secret ?? '')).toThrow();
    expect(view).toMatchObject({ agents: [], header: 'Authorization', signIn: null, verifiedAt: null, policy: { read: 'ask', write: 'deny', tools: { read_private: 'deny', publish: 'ask' } } });
    expect(await api.deps.store.find(TEST_OWNER, source.id)).toEqual(source);
    const assignments = await held.db.select().from(connectorAgents);
    expect(assignments).toHaveLength(1);
    expect(assignments[0]).toMatchObject({ connector: source.id, agent: AGENT, policy: '{"read":"deny"}' });
    expect(await held.db.select().from(mcpCalls)).toHaveLength(1);
    expect(vendor.requests).toEqual([]);
  });

  test('a headerless private URL is still copied as a secret and the destination is readable only in its organization', async () => {
    const source = await seed();
    const { row } = await copied(await post(source.id));
    expect(openConnectorSecret(KEY, row)).toEqual({ kind: 'none', targetUrl: TARGET });
    const destination = await fetch(`${api.base}/api/connectors/${row.id}`, { headers: { authorization: await auth(TEST_STRANGER, 'member') } });
    expect(destination.status).toBe(200);
    const text = await destination.text();
    expect(text).not.toContain('private-path-fixture');
    expect(text).not.toContain('url-secret-fixture');
    expect((await fetch(`${api.base}/api/connectors/${row.id}`, { headers: { authorization: await auth(TEST_OWNER) } })).status).toBe(404);
    expect(await api.deps.store.find(TEST_OWNER, source.id)).toEqual(source);
  });

  test('custom API-key headers are preserved and repeated copies create independent instances', async () => {
    const secret: ConnectorSecret = { kind: 'header', targetUrl: TARGET, name: 'X-Api-Key', value: ' custom-api-key-fixture ' };
    const source = await seed(secret);
    const first = await copied(await post(source.id));
    const second = await copied(await post(source.id));
    expect(first.row.id).not.toBe(second.row.id);
    expect(first.row.authGeneration).not.toBe(second.row.authGeneration);
    expect(openConnectorSecret(KEY, first.row)).toEqual(secret);
    expect(openConnectorSecret(KEY, second.row)).toEqual(secret);
    expect(await api.deps.store.count(TEST_STRANGER)).toBe(2);
    expect(await api.deps.store.find(TEST_OWNER, source.id)).toEqual(source);
  });

  test('an invalid stored policy is retained and fails closed instead of loosening restrictions', async () => {
    const source = await seed(undefined, { policy: 'not valid policy json' });
    const { row, view } = await copied(await post(source.id));
    expect(row.policy).toBe(source.policy);
    expect(view.policy).toEqual({ read: 'deny', write: 'deny' });
  });
});

describe('copy authorization and failures', () => {
  test('no token or source member can copy, even when the user is an active admin in both organizations', async () => {
    const source = await seed();
    expect((await fetch(`${api.base}/api/connectors/${source.id}/copy`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(INPUT) })).status).toBe(401);
    expect((await post(source.id, INPUT, await auth(TEST_OWNER, 'member'))).status).toBe(403);
    expect(checkedUsers).toEqual([]);
    expect(await api.deps.store.count(TEST_STRANGER)).toBe(0);
  });

  test('both memberships are checked fresh on every POST, so a stale admin JWT does not export a secret', async () => {
    const source = await seed();
    const authorization = await auth(TEST_OWNER);
    for (const absent of [TEST_OWNER, TEST_STRANGER]) {
      memberships = [{ id: TEST_OWNER, role: 'admin' }, { id: TEST_STRANGER, role: 'admin' }].filter((membership) => membership.id !== absent);
      expect((await post(source.id, INPUT, authorization)).status).toBe(403);
    }
    for (const demoted of [TEST_OWNER, TEST_STRANGER]) {
      memberships = [{ id: TEST_OWNER, role: 'admin' }, { id: TEST_STRANGER, role: 'admin' }].map((membership) => ({ ...membership, role: membership.id === demoted ? 'member' : membership.role }));
      expect((await post(source.id, INPUT, authorization)).status).toBe(403);
    }
    expect(checkedUsers).toHaveLength(4);
    expect(await api.deps.store.count(TEST_STRANGER)).toBe(0);
    expect(await api.deps.store.find(TEST_OWNER, source.id)).toEqual(source);
  });

  test('unavailable membership verification fails closed without decrypting or creating a connector', async () => {
    const source = await seed();
    api.setKey(null);
    api.deps.organizations = () => Promise.reject(new ApiError('Membership verification is unavailable.', 503));
    const response = await post(source.id);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'Membership verification is unavailable.' });
    expect(await api.deps.store.count(TEST_STRANGER)).toBe(0);
  });

  test('invalid names, destination or missing credential-sharing confirmation store nothing', async () => {
    const source = await seed();
    const invalid = [null, {}, { ...INPUT, organization: TEST_OWNER }, { ...INPUT, organization: 'not-an-org' }, { ...INPUT, name: '' }, { ...INPUT, name: 'x'.repeat(65) }, { ...INPUT, name: 'bad\nname' }, { ...INPUT, shareCredentials: false }, { ...INPUT, shareCredentials: undefined }];
    for (const body of invalid) expect((await post(source.id, body)).status).toBe(400);
    expect(checkedUsers).toEqual([]);
    expect(await api.deps.store.count(TEST_STRANGER)).toBe(0);
  });

  test('source lookup is scoped to the signing organization, not a body owner or membership elsewhere', async () => {
    const source = await seed(undefined, { owner: TEST_STRANGER });
    const res = await post(source.id, { ...INPUT, owner: TEST_STRANGER });
    expect(res.status).toBe(404);
    expect((await post('missing0001')).status).toBe(404);
    expect(await held.db.$count(connectors)).toBe(1);
    expect(await api.deps.store.find(TEST_STRANGER, source.id)).toEqual(source);
  });

  test('missing key, corrupt ciphertext or mismatched auth leave the source intact and expose no configuration', async () => {
    const source = await seed();
    api.setKey(null);
    expect((await post(source.id)).status).toBe(503);
    api.setKey(KEY);
    for (const change of [{ secret: 'v1.broken' }, { secret: null }, { auth: 'header', secret: source.secret }]) {
      await held.db.update(connectors).set(change).where(eq(connectors.id, source.id));
      const before = await api.deps.store.find(TEST_OWNER, source.id);
      const res = await post(source.id);
      expect(res.status).toBe(409);
      const text = await res.text();
      expect(text).not.toContain(TARGET);
      expect(text).not.toContain('url-secret-fixture');
      expect(await api.deps.store.find(TEST_OWNER, source.id)).toEqual(before);
    }
    expect(await api.deps.store.count(TEST_STRANGER)).toBe(0);
  });

  test('the existing destination capacity applies without mutating the source', async () => {
    const source = await seed();
    await held.db.insert(connectors).values(Array.from({ length: 100 }, () => ({ ...source, id: newId(), owner: TEST_STRANGER, secret: null })));
    const response = await post(source.id);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'An organization keeps at most 100 connectors. Remove one first.' });
    expect(await api.deps.store.count(TEST_STRANGER)).toBe(100);
    expect(await api.deps.store.find(TEST_OWNER, source.id)).toEqual(source);
  });

  test('a failed destination insert rolls back while leaving the locked source unchanged', async () => {
    const source = await seed();
    const before = await api.deps.store.find(TEST_OWNER, source.id);
    await expect(api.deps.store.copy(TEST_OWNER, source.id, (row) => ({ ...row, owner: TEST_STRANGER }))).rejects.toThrow('This connector identity already exists. Nothing was overwritten.');
    expect(await api.deps.store.find(TEST_OWNER, source.id)).toEqual(before);
    expect(await api.deps.store.count(TEST_STRANGER)).toBe(0);
  });

  test('the copy route is POST only and has an ordinary CORS preflight', async () => {
    const source = await seed();
    expect((await fetch(`${api.base}/api/connectors/${source.id}/copy`, { headers: { authorization: await auth(TEST_OWNER) } })).status).toBe(405);
    expect((await fetch(`${api.base}/api/connectors/${source.id}/copy`, { method: 'OPTIONS' })).status).toBe(204);
    expect(await api.deps.store.count(TEST_STRANGER)).toBe(0);
  });
});
