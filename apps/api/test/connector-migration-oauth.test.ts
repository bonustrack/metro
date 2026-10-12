import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { openConnectorSecret } from '../src/connectors/model.js';
import { connectorAgents, connectorEvents, connectorMigrations, connectors } from '../src/db/schema.js';
import { enrollDeliveryAgent, MASTER, newDeliveryAgent, type DeliveryAgent } from './connector-delivery-fixture.js';
import { answer, input, payload, prepared, prepareInput, startMigrationApi, vendorFetch, type MigrationApi } from './connector-migration-fixture.js';
import { auth, TEST_OWNER } from './identity-helper.js';
import { ACCESS, challengeOf, REFRESH, RETURN_TO, startApi, startVendor, type Api, type Vendor } from './org-connectors-fixture.js';
import { PGLITE_START_MS, testDb, type TestDb } from './pglite-db.js';

let held: TestDb;
let api: MigrationApi;
let management: Api;
let vendor: Vendor;
let agent: DeliveryAgent;

async function post(path: string, body: unknown): Promise<Response> {
  return fetch(`${management.base}${path}`, { method: 'POST', headers: { authorization: await auth(TEST_OWNER), 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

async function complete(id: string): Promise<void> {
  const started = await post(`/api/connectors/${id}/sign-in`, { returnTo: RETURN_TO });
  expect(started.status).toBe(200);
  const body = await started.json() as { authorizeUrl: string };
  const { state, challenge } = challengeOf(body.authorizeUrl);
  vendor.challenges.set('fresh-central-code', challenge);
  const callback = await fetch(`${management.base}/api/connectors/callback?state=${state}&code=fresh-central-code`, { redirect: 'manual' });
  expect(callback.status).toBe(302);
  const handoff = new URLSearchParams(new URL(callback.headers.get('location') ?? '').hash.split('?')[1]).get('org_connector');
  const response = await post('/api/connectors/complete', { handoff });
  expect(response.status).toBe(200);
  const text = await response.text();
  expect(text).not.toContain(ACCESS);
  expect(text).not.toContain(REFRESH);
}

describe('migration through real central OAuth HTTP sign-in', () => {
  beforeAll(async () => {
    held = await testDb();
    vendor = await startVendor();
    api = await startMigrationApi(held.db, { fetch: vendorFetch(vendor) });
    management = await startApi(() => held.db, Date.now);
    management.setKey(MASTER);
    management.deps.fetch = vendorFetch(vendor);
  }, PGLITE_START_MS);
  beforeEach(async () => {
    await held.reset();
    agent = newDeliveryAgent();
    await enrollDeliveryAgent(held.db, agent);
  });
  afterAll(async () => { await api?.close(); await management?.close(); await vendor?.close(); await held?.close(); });

  test('manual client survives sealed, local tokens never enter central and fresh sign-in is required before activation', async () => {
    const source = payload({ auth: { kind: 'oauth' }, url: 'https://vendor.example/mcp', client: { clientId: 'manual-client', clientSecret: 'MANUAL_CLIENT_SECRET' } });
    const registered = vendor.registrations;
    const ready = await prepared(api, agent, source);
    const id = ready.migration.destinationId;
    expect(ready.migration).toMatchObject({ phase: 'prepared', readiness: 'signin' });
    expect(vendor.registrations).toBe(registered);
    expect((await api.call(agent, input('activate'))).status).toBe(409);
    const row = (await held.db.select().from(connectors).where(eq(connectors.id, id)))[0];
    if (row === undefined) throw new Error('missing OAuth destination');
    const secret = openConnectorSecret(MASTER, row);
    expect(secret?.kind).toBe('oauth');
    if (secret?.kind !== 'oauth') throw new Error('missing OAuth secret');
    expect(secret.client).toEqual(source.client);
    expect(secret.tokens).toBeUndefined();
    const bytes = JSON.stringify({ rows: await held.db.select().from(connectors), mappings: await held.db.select().from(connectorMigrations), events: await held.db.select().from(connectorEvents), response: ready });
    for (const text of ['URL_SECRET', 'MANUAL_CLIENT_SECRET', 'LOCAL_ACCESS', 'LOCAL_REFRESH']) expect(bytes).not.toContain(text);
    await complete(id);
    const signedIn = (await held.db.select().from(connectors).where(eq(connectors.id, id)))[0];
    const deniedDelete = await fetch(`${management.base}/api/connectors/${id}`, { method: 'DELETE', headers: { authorization: await auth(TEST_OWNER) } });
    expect(deniedDelete.status).toBe(409);
    expect((await held.db.select().from(connectors).where(eq(connectors.id, id)))[0]).toEqual(signedIn);
    expect((await answer(await api.call(agent, input('status')))).migration.readiness).toBe('ready');
    expect((await answer(await api.call(agent, input('activate')))).migration.phase).toBe('active');
    expect(await held.db.$count(connectorAgents)).toBe(1);
    await answer(await api.call(agent, input('rollback')));
    expect(await held.db.$count(connectors)).toBe(1);
    expect(await held.db.$count(connectorAgents)).toBe(0);
  });

  test.each(['activate', 'rollback'])('explicit admin deletion stays available after %s', async (action) => {
    const ready = await prepared(api, agent, payload({ auth: { kind: 'none' }, url: 'https://vendor.example/open' }));
    const id = ready.migration.destinationId;
    await answer(await api.call(agent, input(action)));
    const deleted = await fetch(`${management.base}/api/connectors/${id}`, { method: 'DELETE', headers: { authorization: await auth(TEST_OWNER) } });
    expect(deleted.status).toBe(200);
    expect(await held.db.$count(connectors)).toBe(0);
    expect(await held.db.$count(connectorAgents)).toBe(0);
  });

  test('dynamic OAuth registration is fresh in central and none auth verifies with no credentials', async () => {
    const registered = vendor.registrations;
    const ready = await prepared(api, agent, payload({ auth: { kind: 'oauth' }, url: 'https://vendor.example/mcp', client: null }));
    expect(vendor.registrations).toBe(registered + 1);
    const row = (await held.db.select().from(connectors).where(eq(connectors.id, ready.migration.destinationId)))[0];
    if (row === undefined) throw new Error('missing OAuth destination');
    const secret = openConnectorSecret(MASTER, row);
    if (secret?.kind !== 'oauth') throw new Error('missing OAuth secret');
    expect(secret.client.clientId).toBe(`client-${String(vendor.registrations)}`);
    expect(secret.tokens).toBeUndefined();
    await answer(await api.call(agent, input('rollback')));
    const begin = await answer(await api.call(agent, input('begin', 'oper0000002')));
    const open = await answer(await api.call(agent, prepareInput(begin, payload({ name: 'Public', auth: { kind: 'none' }, url: 'https://vendor.example/open' }))));
    expect(open.migration.readiness).toBe('ready');
    expect((await answer(await api.call(agent, input('activate', 'oper0000002')))).migration.phase).toBe('active');
  });
});
