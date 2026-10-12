import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { openSecret } from '../src/connectors/secrets.ts';
import { connectorAgents, connectorEvents, connectors } from '../src/db/schema.ts';
import { auth, bearer, TEST_OWNER, TEST_STRANGER } from './identity-helper.ts';
import { addAgent, PGLITE_START_MS, PGLITE_STEP_MS, testDb, type TestDb } from './pglite-db.ts';
import { addUser, GOOD_KEY, startApi, startVendor, type Api, type Vendor } from './org-connectors-fixture.ts';

const OURS = 'agent000001';
const SECOND = 'agent000002';
const THEIRS = 'agent000003';
const ADMIN_USER = 'user_01ABC';

let held: TestDb;
let vendor: Vendor;
let api: Api;
let now = Date.parse('2026-10-11T05:00:00.000Z');

const call = async (method: string, path: string, body?: unknown, authorization?: string): Promise<Response> => {
  now += 1;
  return fetch(`${api.base}${path}`, {
    method,
    headers: { authorization: authorization ?? (await auth(TEST_OWNER)), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
};

const data = async <T>(res: Response): Promise<T> => (await res.json()) as T;

interface View {
  id: string;
  name: string;
  auth: string;
  header: string | null;
  server: string | null;
  readOnly: boolean;
  signIn: string | null;
  agents: { id: string; readOnly: boolean }[];
}

const addKeyed = async (name = 'Linear'): Promise<View> => {
  const res = await call('POST', '/api/connectors', { name, url: `${vendor.base}/keyed`, value: GOOD_KEY });
  expect(res.status).toBe(201);
  return (await data<{ connector: View }>(res)).connector;
};

const eventsOf = async (connector: string): Promise<{ action: string }[]> =>
  held.db.select({ action: connectorEvents.action }).from(connectorEvents).where(eq(connectorEvents.connector, connector)).orderBy(connectorEvents.at, connectorEvents.id);

beforeAll(async () => {
  held = await testDb();
  vendor = await startVendor();
  api = await startApi(() => held.db, () => now, vendor.fetch);
}, PGLITE_START_MS);

beforeEach(async () => {
  now += 60_000;
  api.setEnabled(true);
  await held.reset();
  await addAgent(held.db, OURS, TEST_OWNER);
  await addAgent(held.db, SECOND, TEST_OWNER);
  await addAgent(held.db, THEIRS, TEST_STRANGER);
  await addUser(held.db, ADMIN_USER, 'Less', 'less@example.com');
}, PGLITE_STEP_MS);

afterAll(async () => {
  await api.close();
  await vendor.close();
  await held.close();
});

describe('the switch and who may do what', () => {
  test('every route answers 503 while organization connectors are off', async () => {
    api.setEnabled(false);
    for (const [method, path] of [['GET', '/api/connectors'], ['POST', '/api/connectors'], ['GET', '/api/connectors/events'], ['GET', '/api/connectors/callback?state=x&code=y']] as const) {
      const res = await call(method, path, method === 'POST' ? {} : undefined);
      expect(res.status).toBe(503);
      expect((await data<{ error: string }>(res)).error).toBe('Organization connectors are not switched on yet.');
    }
  });

  test('a member reads the list, only an admin changes it, nobody signed out gets in', async () => {
    const member = await auth(TEST_OWNER, 'member');
    expect((await fetch(`${api.base}/api/connectors`)).status).toBe(401);
    const list = await call('GET', '/api/connectors', undefined, member);
    expect(list.status).toBe(200);
    expect(await data<unknown>(list)).toEqual({ connectors: [], admin: false });
    expect((await call('POST', '/api/connectors', { name: 'x', url: `${vendor.base}/open` }, member)).status).toBe(403);
    expect((await call('GET', '/api/connectors/events', undefined, member)).status).toBe(403);
  });

  test('without METRO_CONNECTORS_KEY nothing is added', async () => {
    api.setKey(null);
    const res = await call('POST', '/api/connectors', { name: 'Linear', url: `${vendor.base}/keyed`, value: GOOD_KEY });
    expect(res.status).toBe(503);
    expect((await data<{ error: string }>(res)).error).toContain('METRO_CONNECTORS_KEY');
    api.setKey(Buffer.alloc(32, 7));
  });
});

describe('adding a connector', () => {
  test('the full URL, including query credentials and paths, is sealed and never shown to a member', async () => {
    const targetUrl = `${vendor.base}/query-keyed?api_key=URL_ONLY_SECRET`;
    const created = await data<{ connector: View }>(await call('POST', '/api/connectors', { name: 'Query keyed', url: targetUrl }));
    const row = (await held.db.select().from(connectors).where(eq(connectors.id, created.connector.id)))[0];
    const key = api.deps.key();
    if (row === undefined || row.secret === null || key === null) throw new Error('secret missing');
    expect(row.url).toBe(vendor.base);
    expect(JSON.stringify(row)).not.toContain('URL_ONLY_SECRET');
    expect(openSecret(key, TEST_OWNER, row.id, row.secret)).toEqual({ kind: 'none', targetUrl });
    const member = await call('GET', '/api/connectors', undefined, await auth(TEST_OWNER, 'member'));
    expect(member.status).toBe(200);
    const shown = await member.text();
    expect(shown).not.toContain('URL_ONLY_SECRET');
    expect(shown).not.toContain('/query-keyed');
    const activity = await call('GET', '/api/connectors/events');
    expect(await activity.text()).not.toContain('URL_ONLY_SECRET');
  });

  test('a key connector is verified first and its key is kept sealed, never shown', async () => {
    const res = await call('POST', '/api/connectors', { name: 'Linear', url: `${vendor.base}/keyed`, value: GOOD_KEY });
    expect(res.status).toBe(201);
    const text = await res.text();
    expect(text).not.toContain('good-vendor-key');
    const view = (JSON.parse(text) as { connector: View }).connector;
    expect(view).toMatchObject({ name: 'Linear', auth: 'header', header: 'Authorization', server: new URL(vendor.base).hostname, readOnly: false, signIn: null, agents: [] });
    const row = (await held.db.select().from(connectors).where(eq(connectors.id, view.id)))[0];
    expect(row?.secret).toMatch(/^v1\./);
    expect(row?.secret).not.toContain('good-vendor-key');
    const key = api.deps.key();
    if (row === undefined || row.secret === null || key === null) throw new Error('the row was not stored');
    expect(openSecret(key, TEST_OWNER, view.id, row.secret)).toEqual({ kind: 'header', targetUrl: `${vendor.base}/keyed`, name: 'Authorization', value: GOOD_KEY });
    expect(await eventsOf(view.id)).toEqual([{ action: 'connector.created' }]);
  });

  test('a wrong key, a non-MCP address or a bad url stores nothing', async () => {
    const wrong = await call('POST', '/api/connectors', { name: 'Linear', url: `${vendor.base}/keyed`, value: 'Bearer nope' });
    expect(wrong.status).toBe(400);
    expect((await data<{ error: string }>(wrong)).error).toBe('The provider could not verify the HTTP MCP endpoint. Check its endpoint and authentication settings.');
    expect((await call('POST', '/api/connectors', { name: 'Bad', url: 'ftp://vendor.example' })).status).toBe(400);
    expect((await call('POST', '/api/connectors', { name: '', url: `${vendor.base}/open` })).status).toBe(400);
    expect((await call('POST', '/api/connectors', { name: 'Gone', url: `${vendor.base}/nothing-here` })).status).toBe(400);
    expect(await held.db.select().from(connectors)).toEqual([]);
  });

  test('an open server needs no credential and repeated names and endpoints create independent connectors', async () => {
    const res = await call('POST', '/api/connectors', { name: 'Docs', url: `${vendor.base}/open` });
    expect(res.status).toBe(201);
    const first = (await data<{ connector: View }>(res)).connector;
    expect(first).toMatchObject({ auth: 'none', header: null, server: new URL(vendor.base).hostname });
    const again = await call('POST', '/api/connectors', { name: 'Docs', url: `${vendor.base}/open` });
    expect(again.status).toBe(201);
    expect((await data<{ connector: View }>(again)).connector.id).not.toBe(first.id);
    expect((await call('POST', '/api/connectors', { name: 'Docs', url: `${vendor.base}/open` }, await auth(TEST_STRANGER))).status).toBe(201);
    expect(await held.db.$count(connectors)).toBe(3);
  });
});

describe('changing a connector', () => {
  test('rename, read-only for every agent and a new key are one change at a time', async () => {
    const view = await addKeyed();
    const other = await addKeyed('Linear work');
    expect((await call('PUT', `/api/connectors/${view.id}`, { name: 'Linear', readOnly: true })).status).toBe(400);
    const renamed = await call('PUT', `/api/connectors/${view.id}`, { name: other.name });
    expect(renamed.status).toBe(200);
    expect(await data<View>(renamed)).toMatchObject({ id: view.id, name: other.name });
    expect(await data<View>(await call('GET', `/api/connectors/${other.id}`))).toMatchObject({ id: other.id, name: other.name, readOnly: false });
    const locked = await call('PUT', `/api/connectors/${view.id}`, { readOnly: true });
    expect((await data<View>(locked)).readOnly).toBe(true);
    expect((await held.db.select({ policy: connectors.policy }).from(connectors).where(eq(connectors.id, view.id)))[0]?.policy).toBe('{"write":"deny"}');
    expect((await call('PUT', `/api/connectors/${view.id}`, { value: 'Bearer nope' })).status).toBe(400);
    const rekeyed = await call('PUT', `/api/connectors/${view.id}`, { header: 'Authorization', value: GOOD_KEY });
    expect(rekeyed.status).toBe(200);
    expect((await eventsOf(view.id)).map((e) => e.action)).toEqual(['connector.created', 'connector.renamed', 'connector.read_only_changed', 'connector.key_changed']);
    const activity = await data<{ events: { action: string; connector: { name: string } }[] }>(await call('GET', `/api/connectors/events?connector=${view.id}`));
    expect(activity.events.find((e) => e.action === 'connector.renamed')?.connector.name).toBe('Linear');
  });

  test('another organization sees and changes nothing', async () => {
    const view = await addKeyed();
    const stranger = await auth(TEST_STRANGER);
    expect((await call('GET', `/api/connectors/${view.id}`, undefined, stranger)).status).toBe(404);
    expect((await call('PUT', `/api/connectors/${view.id}`, { name: 'Mine' }, stranger)).status).toBe(404);
    expect((await call('DELETE', `/api/connectors/${view.id}`, undefined, stranger)).status).toBe(404);
    expect((await call('PUT', `/api/connectors/${view.id}/agents/${THEIRS}`, {}, stranger)).status).toBe(404);
    expect((await data<{ connectors: View[] }>(await call('GET', '/api/connectors', undefined, stranger))).connectors).toEqual([]);
  });
});

describe('assigning a connector to agents', () => {
  test('an agent of the organization gets it, read-only when asked, and loses it again', async () => {
    const view = await addKeyed();
    const assigned = await call('PUT', `/api/connectors/${view.id}/agents/${OURS}`, { readOnly: true });
    expect(assigned.status).toBe(200);
    expect((await data<View>(assigned)).agents).toEqual([{ id: OURS, readOnly: true, policy: { write: 'deny' }, assignedAt: expect.any(String) as unknown as string }]);
    const same = await call('PUT', `/api/connectors/${view.id}/agents/${OURS}`, { readOnly: true });
    expect(same.status).toBe(200);
    const opened = await call('PUT', `/api/connectors/${view.id}/agents/${OURS}`, { readOnly: false });
    expect((await data<View>(opened)).agents[0]?.readOnly).toBe(false);
    await call('PUT', `/api/connectors/${view.id}/agents/${SECOND}`, {});
    expect((await call('PUT', `/api/connectors/${view.id}/agents/${THEIRS}`, {})).status).toBe(404);
    expect((await call('PUT', `/api/connectors/${view.id}/agents/${OURS}`, { readOnly: 'yes' })).status).toBe(400);
    const dropped = await call('DELETE', `/api/connectors/${view.id}/agents/${OURS}`);
    expect((await data<View>(dropped)).agents.map((a) => a.id)).toEqual([SECOND]);
    expect((await call('DELETE', `/api/connectors/${view.id}/agents/${OURS}`)).status).toBe(404);
    expect((await eventsOf(view.id)).map((e) => e.action)).toEqual(['connector.created', 'connector.assigned', 'connector.assignment_changed', 'connector.assigned', 'connector.unassigned']);
  });

  test('deleting a connector removes its assignments, the audit log keeps its name', async () => {
    const view = await addKeyed();
    await call('PUT', `/api/connectors/${view.id}/agents/${OURS}`, {});
    const gone = await call('DELETE', `/api/connectors/${view.id}`);
    expect(await data<unknown>(gone)).toEqual({ id: view.id, deleted: true });
    expect((await call('GET', `/api/connectors/${view.id}`)).status).toBe(404);
    expect(await held.db.select().from(connectorAgents)).toEqual([]);
    const log = await data<{ events: { action: string; connector: { name: string } | null; actor: { name: string | null } }[] }>(await call('GET', `/api/connectors/events?connector=${view.id}`));
    expect(log.events.map((e) => e.action)).toEqual(['connector.deleted', 'connector.assigned', 'connector.created']);
    expect(log.events[0]?.connector?.name).toBe('Linear');
    expect(log.events[0]?.actor.name).toBe('Less');
  });
});

describe('the audit log', () => {
  test('pages newest first and names who did what', async () => {
    const view = await addKeyed();
    for (let i = 0; i < 55; i += 1) {
      now += 1_000;
      await call('PUT', `/api/connectors/${view.id}`, { readOnly: i % 2 === 0 });
    }
    const first = await data<{ events: { id: string; at: string }[]; next: { before: string; beforeId: string } | null }>(await call('GET', '/api/connectors/events'));
    expect(first.events).toHaveLength(50);
    expect(first.next).not.toBeNull();
    const next = first.next ?? { before: '', beforeId: '' };
    const second = await data<{ events: { id: string }[]; next: unknown }>(await call('GET', `/api/connectors/events?before=${encodeURIComponent(next.before)}&beforeId=${next.beforeId}`));
    expect(second.events).toHaveLength(6);
    expect(second.next).toBeNull();
    expect(new Set([...first.events, ...second.events].map((e) => e.id)).size).toBe(56);
    expect((await call('GET', '/api/connectors/events?before=yesterday&beforeId=x')).status).toBe(400);
    const other = await bearer({ sub: 'user_01OTHER', org_id: TEST_STRANGER, role: 'admin' });
    expect((await data<{ events: unknown[] }>(await call('GET', '/api/connectors/events', undefined, other))).events).toEqual([]);
  });
});
