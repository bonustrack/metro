import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { credentialRevision } from '../src/connectors/delivery-model.js';
import { migrationConfigStamp } from '../src/connectors/migration-model.js';
import { openConnectorSecret, sealConnectorSecret } from '../src/connectors/model.js';
import { connectorAgents, connectorMigrations, connectors } from '../src/db/schema.js';
import { enrollDeliveryAgent, MASTER, newDeliveryAgent, opaque, openResponse, startDeliveryApi, type DeliveryAgent } from './connector-delivery-fixture.js';
import { answer, input, payload, prepared, prepareInput, startMigrationApi, type MigrationApi } from './connector-migration-fixture.js';
import { auth, TEST_OWNER } from './identity-helper.js';
import { ACCESS, challengeOf, GOOD_KEY, REFRESH, RETURN_TO, startApi, startVendor, type Api, type Vendor } from './org-connectors-fixture.js';
import { PGLITE_START_MS, testDb, type TestDb } from './pglite-db.js';

let held: TestDb;
let api: MigrationApi;
let management: Api;
let vendor: Vendor;
let agent: DeliveryAgent;

async function post(path: string, body: unknown): Promise<Response> {
  return fetch(`${management.base}${path}`, { method: 'POST', headers: { authorization: await auth(TEST_OWNER), 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

async function complete(id: string, hidden: string[] = []): Promise<void> {
  const started = await post(`/api/connectors/${id}/sign-in`, { returnTo: RETURN_TO });
  expect(started.status).toBe(200);
  const body = await started.json() as { authorizeUrl: string };
  const { state, challenge, resource } = challengeOf(body.authorizeUrl);
  expect(resource).toBe(vendor.resource);
  for (const value of hidden) expect(decodeURIComponent(body.authorizeUrl)).not.toContain(value);
  vendor.challenges.set('fresh-central-code', challenge);
  const callback = await fetch(`${management.base}/api/connectors/callback?state=${state}&code=fresh-central-code`, { redirect: 'manual' });
  expect(callback.status).toBe(302);
  const handoff = new URLSearchParams(new URL(callback.headers.get('location') ?? '').hash.split('?')[1]).get('org_connector');
  const response = await post('/api/connectors/complete', { handoff });
  expect(response.status).toBe(200);
  const text = await response.text();
  expect(text).not.toContain(ACCESS);
  expect(text).not.toContain(REFRESH);
  expect(JSON.parse(text)).toMatchObject({ server: new URL(vendor.base).hostname, signIn: 'connected' });
  for (const value of hidden) {
    expect(text).not.toContain(value);
    expect(decodeURIComponent(callback.headers.get('location') ?? '')).not.toContain(value);
  }
}

describe('migration through real central OAuth HTTP sign-in', () => {
  beforeAll(async () => {
    held = await testDb();
    vendor = await startVendor();
    api = await startMigrationApi(held.db, { fetch: vendor.fetch });
    management = await startApi(() => held.db, Date.now, vendor.fetch);
    management.setKey(MASTER);
  }, PGLITE_START_MS);
  beforeEach(async () => {
    vendor.resource = `${vendor.base}/oauth`;
    vendor.requests.length = 0;
    vendor.received.length = 0;
    vendor.tokenForms.length = 0;
    vendor.replies.clear();
    vendor.serverTitle = null;
    await held.reset();
    agent = newDeliveryAgent();
    await enrollDeliveryAgent(held.db, agent);
  });
  afterAll(async () => { await api?.close(); await management?.close(); await vendor?.close(); await held?.close(); });

  test('manual client survives sealed, local tokens never enter central and fresh sign-in is required before activation', async () => {
    const source = payload({ auth: { kind: 'oauth' }, url: `${vendor.base}/oauth`, client: { clientId: 'manual-client', clientSecret: 'MANUAL_CLIENT_SECRET' } });
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
    const bytes = JSON.stringify({ rows: await held.db.select().from(connectors), mappings: await held.db.select().from(connectorMigrations), response: ready });
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

  test.each([
    { path: '/rpc/v2/tenant-secret/tools', resource: '/', explicit: false },
    { path: '/mcp-server/http/tenant-secret', resource: '/mcp-server', explicit: false },
    { path: '/mcp/tenant-secret/stream', resource: '/mcp', explicit: true },
    { path: '/n8n/mcp/tenant-secret/capability', resource: '/n8n/mcp', explicit: true },
    { path: '/tenant%2fsecret/tool%20endpoint/%7ecapability', resource: '/', explicit: false },
    { path: '/rpc/SECRET_PATH%2fcapability/tools', resource: '/', explicit: false },
  ])('public audience stays separate from exact transport $path', async ({ path, resource, explicit }) => {
    const targetUrl = `${vendor.base}${path}?api_key=URL_SECRET&token=SECRET_QUERY&sig=Sealed%2fSecret&x=1&x=2`;
    vendor.resource = `${vendor.base}${resource}`;
    vendor.oauthPaths.add(path);
    vendor.serverTitle = targetUrl;
    const source = payload({ auth: { kind: 'oauth' }, url: targetUrl, client: { clientId: 'public-client', clientSecret: 'MANUAL_CLIENT_SECRET' }, ...(explicit ? { oauthResource: vendor.resource } : {}) });
    const ready = await prepared(api, agent, source);
    expect(ready.migration.readiness).toBe('signin');
    const id = ready.migration.destinationId;
    const metadataPath = `/.well-known/oauth-protected-resource${explicit ? resource : ''}`;
    expect(vendor.requests[0]?.url).toBe(`${vendor.base}${metadataPath}`);
    expect(vendor.requests.every((request) => ['URL_SECRET', 'SECRET_QUERY', 'SECRET_PATH', 'tenant-secret'].every((secret) => !request.url.includes(secret)))).toBe(true);
    await complete(id, ['URL_SECRET', 'SECRET_QUERY', 'SECRET_PATH', 'Sealed/Secret', path, 'MANUAL_CLIENT_SECRET']);
    const current = (await held.db.select().from(connectors).where(eq(connectors.id, id)))[0];
    if (current === undefined) throw new Error('missing signed-in connector');
    expect(current.url).toBe(vendor.base);
    expect(openConnectorSecret(MASTER, current)).toMatchObject({ targetUrl, oauthResource: vendor.resource, tokens: { resource: vendor.resource, accessToken: ACCESS, refreshToken: REFRESH } });
    expect((await answer(await api.call(agent, input('status')))).migration.readiness).toBe('ready');
    expect((await answer(await api.call(agent, input('activate')))).migration.phase).toBe('active');
    const delivery = await startDeliveryApi(held.db, { fetch: vendor.fetch });
    try {
      const requestId = opaque();
      const response = await delivery.call(agent, { requestId, refresh: { connectorId: id, revision: credentialRevision(MASTER, current) } });
      expect(response.status).toBe(200);
      const encrypted = await response.clone().text();
      for (const hidden of [targetUrl, 'URL_SECRET', 'SECRET_QUERY', 'SECRET_PATH', ACCESS, REFRESH, 'MANUAL_CLIENT_SECRET']) expect(encrypted).not.toContain(hidden);
      const snapshot = await openResponse(response, agent, requestId);
      expect(snapshot.connectors[0]).toMatchObject({ id, url: targetUrl, state: 'ready', headers: { Authorization: `Bearer ${ACCESS}` } });
      expect(JSON.stringify(snapshot)).not.toContain(REFRESH);
      expect(JSON.stringify(snapshot)).not.toContain('MANUAL_CLIENT_SECRET');
    } finally { await delivery.close(); }
    expect(vendor.tokenForms.map((form) => [form.get('grant_type'), form.get('resource')])).toEqual([['authorization_code', vendor.resource], ['refresh_token', vendor.resource]]);
    const verification = vendor.requests.filter((request) => request.method === 'POST' && request.body.includes('initialize'));
    expect(verification).toHaveLength(2);
    expect(verification.every((request) => request.url === targetUrl && request.headers.get('authorization') === `Bearer ${ACCESS}`)).toBe(true);
    expect(vendor.received.filter((request) => request.path.startsWith(path))).toEqual(Array.from({ length: 2 }, () => ({ path: targetUrl.slice(vendor.base.length), method: 'POST', authorization: `Bearer ${ACCESS}` })));
    const stored = JSON.stringify({ rows: await held.db.select().from(connectors), migrations: await held.db.select().from(connectorMigrations), migration: ready });
    for (const hidden of [path, 'URL_SECRET', 'SECRET_QUERY', 'SECRET_PATH', 'Sealed%2fSecret', ACCESS, REFRESH, 'MANUAL_CLIENT_SECRET']) expect(stored).not.toContain(hidden);
    for (const route of ['/api/connectors', `/api/connectors/${id}`]) {
      const shown = await (await fetch(`${management.base}${route}`, { headers: { authorization: await auth(TEST_OWNER, 'member') } })).text();
      for (const hidden of [path, 'URL_SECRET', 'SECRET_QUERY', 'SECRET_PATH', ACCESS, REFRESH, 'MANUAL_CLIENT_SECRET']) expect(shown).not.toContain(hidden);
    }
  });

  test.each(['none', 'header'] as const)('%s migration keeps secret path and query only in sealed storage and exact vendor transport', async (kind) => {
    const path = `/tenant/SECRET_PATH%2fcapability/${kind}`;
    const query = '?key=SECRET_QUERY&sig=opaque%2fvalue&x=1&x=2';
    const targetUrl = `${vendor.base}${path}${query}`;
    const authKind = kind === 'header' ? { kind, name: 'Authorization', value: GOOD_KEY } : { kind };
    const authorization = kind === 'header' ? GOOD_KEY : '';
    const hidden = ['SECRET_PATH', 'SECRET_QUERY', 'opaque%2fvalue', GOOD_KEY];
    (kind === 'header' ? vendor.keyedPaths : vendor.openPaths).add(path);
    vendor.serverTitle = targetUrl;
    const ready = await prepared(api, agent, payload({ auth: authKind, url: targetUrl, client: null }));
    expect(ready.migration).toMatchObject({ phase: 'prepared', readiness: 'ready' });
    const id = ready.migration.destinationId;
    const current = (await held.db.select().from(connectors).where(eq(connectors.id, id)))[0];
    if (current === undefined) throw new Error('missing prepared connector');
    expect(openConnectorSecret(MASTER, current)).toEqual({ ...authKind, targetUrl });
    expect(current.url).toBe(vendor.base);
    const active = await answer(await api.call(agent, input('activate')));
    expect(active.migration.phase).toBe('active');
    expect(vendor.received).toEqual(Array.from({ length: 2 }, () => ({ path: `${path}${query}`, method: 'POST', authorization })));
    expect(vendor.requests.every((request) => request.url === targetUrl)).toBe(true);
    const delivery = await startDeliveryApi(held.db, { fetch: vendor.fetch });
    try {
      const requestId = opaque();
      const response = await delivery.call(agent, { requestId });
      expect(response.status).toBe(200);
      const encrypted = await response.clone().text();
      for (const secret of hidden) expect(encrypted).not.toContain(secret);
      expect((await openResponse(response, agent, requestId)).connectors[0]).toMatchObject({ id, url: targetUrl, state: 'ready', headers: kind === 'header' ? { Authorization: GOOD_KEY } : {} });
    } finally { await delivery.close(); }
    const persisted = JSON.stringify({ rows: await held.db.select().from(connectors), mappings: await held.db.select().from(connectorMigrations), prepared: ready, active });
    for (const secret of hidden) expect(persisted).not.toContain(secret);
    for (const route of ['/api/connectors', `/api/connectors/${id}`]) {
      const response = await fetch(`${management.base}${route}`, { headers: { authorization: await auth(TEST_OWNER, 'member') } });
      expect(response.status).toBe(200);
      const shown = await response.text();
      for (const secret of hidden) expect(shown).not.toContain(secret);
      if (route === `/api/connectors/${id}`) expect(JSON.parse(shown)).toMatchObject({ server: new URL(vendor.base).hostname });
    }
    vendor.replies.set(path, { status: 400, body: { error: `${targetUrl} ${GOOD_KEY}` } });
    const failed = await api.call(agent, input('activate'));
    expect(failed.status).toBe(409);
    const error = await failed.text();
    for (const secret of hidden) expect(error).not.toContain(secret);
    expect(error).toContain('The destination is not ready');
  });

  test('missing metadata resource stays preparing until an explicit public audience is provided', async () => {
    vendor.resource = null;
    const source = payload({ auth: { kind: 'oauth' }, url: `${vendor.base}/oauth/private-tenant?key=URL_SECRET`, client: { clientId: 'manual-client' } });
    vendor.oauthPaths.add('/oauth/private-tenant');
    const begin = await answer(await api.call(agent, input('begin')));
    const refused = await api.call(agent, prepareInput(begin, source));
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ code: 'oauth_resource_required' });
    expect(await held.db.$count(connectors)).toBe(0);
    expect((await answer(await api.call(agent, input('status')))).migration).toMatchObject({ phase: 'preparing', readiness: 'pending' });
    const ready = await answer(await api.call(agent, prepareInput(begin, { ...source, oauthResource: `${vendor.base}/oauth` })));
    expect(ready.migration).toMatchObject({ phase: 'prepared', readiness: 'signin' });
  });

  test('static audience invalidates a migration but token and grant changes do not', async () => {
    const ready = await prepared(api, agent, payload({ auth: { kind: 'oauth' }, url: `${vendor.base}/oauth/private?key=URL_SECRET`, client: null }));
    const id = ready.migration.destinationId;
    const row = (await held.db.select().from(connectors).where(eq(connectors.id, id)))[0];
    if (row === undefined) throw new Error('missing prepared row');
    const secret = openConnectorSecret(MASTER, row);
    if (secret?.kind !== 'oauth') throw new Error('missing OAuth secret');
    const stamp = migrationConfigStamp(MASTER, row);
    const grantOnly = { ...row, secret: sealConnectorSecret(MASTER, row, { ...secret, tokens: { accessToken: ACCESS, resource: `${vendor.base}/`, expiresAt: Date.now() + 3600_000 } }) };
    expect(migrationConfigStamp(MASTER, grantOnly)).toBe(stamp);
    const changed = sealConnectorSecret(MASTER, row, { ...secret, oauthResource: `${vendor.base}/` });
    expect(migrationConfigStamp(MASTER, { ...row, secret: changed })).not.toBe(stamp);
    await held.db.update(connectors).set({ secret: changed }).where(eq(connectors.id, id));
    expect((await answer(await api.call(agent, input('status')))).migration.readiness).toBe('changed');
    expect((await api.call(agent, input('activate'))).status).toBe(409);
    expect(await held.db.$count(connectorAgents)).toBe(0);
  });

  test.each(['activate', 'rollback'])('explicit admin deletion stays available after %s', async (action) => {
    const ready = await prepared(api, agent, payload({ auth: { kind: 'none' }, url: `${vendor.base}/open` }));
    const id = ready.migration.destinationId;
    await answer(await api.call(agent, input(action)));
    const deleted = await fetch(`${management.base}/api/connectors/${id}`, { method: 'DELETE', headers: { authorization: await auth(TEST_OWNER) } });
    expect(deleted.status).toBe(200);
    expect(await held.db.$count(connectors)).toBe(0);
    expect(await held.db.$count(connectorAgents)).toBe(0);
  });

  test('dynamic OAuth registration is fresh in central and none auth verifies with no credentials', async () => {
    const registered = vendor.registrations;
    const ready = await prepared(api, agent, payload({ auth: { kind: 'oauth' }, url: `${vendor.base}/oauth`, client: null }));
    expect(vendor.registrations).toBe(registered + 1);
    const row = (await held.db.select().from(connectors).where(eq(connectors.id, ready.migration.destinationId)))[0];
    if (row === undefined) throw new Error('missing OAuth destination');
    const secret = openConnectorSecret(MASTER, row);
    if (secret?.kind !== 'oauth') throw new Error('missing OAuth secret');
    expect(secret.client.clientId).toBe(`client-${String(vendor.registrations)}`);
    expect(secret.tokens).toBeUndefined();
    await answer(await api.call(agent, input('rollback')));
    const begin = await answer(await api.call(agent, input('begin', 'oper0000002')));
    const open = await answer(await api.call(agent, prepareInput(begin, payload({ name: 'Public', auth: { kind: 'none' }, url: `${vendor.base}/open` }))));
    expect(open.migration.readiness).toBe('ready');
    expect((await answer(await api.call(agent, input('activate', 'oper0000002')))).migration.phase).toBe('active');
  });
});
