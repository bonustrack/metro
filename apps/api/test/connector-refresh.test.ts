import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { credentialRevision } from '../src/connectors/delivery-model.js';
import { openConnectorSecret, sealConnectorSecret } from '../src/connectors/model.js';
import { connectorEvents, connectors } from '../src/db/schema.js';
import { PGLITE_START_MS, PGLITE_STEP_MS, testDb, type TestDb } from './pglite-db.js';
import { CONN, MASTER, assignConnector, enrollDeliveryAgent, newDeliveryAgent, oauthSecret, opaque, openResponse, seedConnector, startDeliveryApi, type DeliveryAgent } from './connector-delivery-fixture.js';

let held: TestDb;
let api: Awaited<ReturnType<typeof startDeliveryApi>>;
let agent: DeliveryAgent;

beforeAll(async () => { held = await testDb(); }, PGLITE_START_MS);
beforeEach(async () => {
  await held.reset();
  agent = newDeliveryAgent();
  await enrollDeliveryAgent(held.db, agent);
  api = await startDeliveryApi(held.db);
}, PGLITE_STEP_MS);
afterAll(async () => { await held.close(); });

async function done(work: () => Promise<void>): Promise<void> {
  try { await work(); } finally { await api.close(); }
}

async function secretNow() {
  const row = (await held.db.select().from(connectors).where(eq(connectors.id, CONN)))[0];
  if (row === undefined) throw new Error('missing row');
  const secret = openConnectorSecret(MASTER, row);
  if (secret?.kind !== 'oauth') throw new Error('not OAuth');
  return { row, secret };
}

describe('central encrypted OAuth refresh', () => {
  test('an expired access token refreshes with scoped resource and client through the injected fetch, and rotates refresh tokens', () => done(async () => {
    const original = await seedConnector(held.db, oauthSecret());
    await assignConnector(held.db, agent);
    let calls = 0;
    api.deps.fetch = (url, init) => {
      calls += 1;
      expect(url).toBe('https://vendor.example/token');
      expect(init?.redirect).toBe('manual');
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(Object.fromEntries(new URLSearchParams(String(init?.body)))).toEqual({ grant_type: 'refresh_token', refresh_token: 'REFRESH_OLD', resource: 'https://vendor.example/mcp', scope: 'read write', client_id: 'CLIENT_ID', client_secret: 'CLIENT_SECRET' });
      return Promise.resolve(Response.json({ access_token: 'ACCESS_NEW', refresh_token: 'REFRESH_ROTATED', expires_in: 3600 }));
    };
    const requestId = opaque();
    const response = await api.call(agent, { requestId });
    expect(response.status).toBe(200);
    const delivery = await openResponse(response, agent, requestId);
    expect(delivery.connectors[0]).toMatchObject({ state: 'ready', headers: { Authorization: 'Bearer ACCESS_NEW' } });
    expect(calls).toBe(1);
    const current = await secretNow();
    expect(current.secret.tokens?.refreshToken).toBe('REFRESH_ROTATED');
    expect(current.secret.tokens?.resource).toBe('https://vendor.example/mcp');
    expect(current.secret.targetUrl).toBe('https://vendor.example/mcp?key=URL_SECRET');
    expect(delivery.connectors[0]?.url).toBe(current.secret.targetUrl);
    expect(current.row.secret).not.toContain('REFRESH_ROTATED');
    expect(current.row.secret).not.toBe(original.secret);
    expect(delivery.connectors[0]?.revision).not.toBe(credentialRevision(MASTER, original));
    expect((await held.db.select().from(connectorEvents)).map((row) => [row.action, row.detail])).toEqual([['agent.enrolled', JSON.stringify({ keyId: agent.row.keyId })], ['connector.refreshed', '{"name":"Calendar"}'], ['connector.delivered', '{"name":"Calendar"}']]);
  }));

  test.each([false, true])('legacy tokens without a public grant resource require fresh sign-in, expired=%s', (expired) => done(async () => {
    const secret = oauthSecret(expired ? Date.now() - 1 : Date.now() + 3600_000);
    if (secret.tokens === undefined) throw new Error('missing fixture');
    delete secret.tokens.resource;
    await seedConnector(held.db, secret);
    await assignConnector(held.db, agent);
    let calls = 0;
    api.deps.fetch = () => { calls += 1; throw new Error('Legacy resource must not refresh'); };
    const requestId = opaque();
    const response = await api.call(agent, { requestId });
    expect(response.status).toBe(200);
    expect((await openResponse(response, agent, requestId)).connectors[0]).toMatchObject({ state: 'signin', headers: {} });
    const current = await secretNow();
    expect(current.secret.tokens).toBeUndefined();
    expect(current.secret.oauthResource).toBe(secret.oauthResource);
    expect(current.secret.targetUrl).toBe(secret.targetUrl);
    expect(current.row.detail).toBeNull();
    expect(calls).toBe(0);
    const events = await held.db.select().from(connectorEvents);
    expect(events.find((event) => event.action === 'connector.signed_out')?.detail).toBe('{"name":"Calendar","reason":"resource_required"}');
    for (const hidden of ['URL_SECRET', 'ACCESS_OLD', 'REFRESH_OLD', 'CLIENT_SECRET']) expect(JSON.stringify(events)).not.toContain(hidden);
  }));

  test.each(['stale revision', 'allowed tool exception'])('resource-less grants cannot bypass reauthentication through %s', (mode) => done(async () => {
    const secret = oauthSecret(Date.now() + 3600_000);
    if (secret.tokens === undefined) throw new Error('missing fixture');
    delete secret.tokens.resource;
    const policy = mode === 'allowed tool exception' ? '{"read":"deny","write":"deny","tools":{"read_item":"allow"}}' : null;
    const row = await seedConnector(held.db, secret, { policy });
    await assignConnector(held.db, agent);
    let calls = 0;
    api.deps.fetch = () => { calls += 1; throw new Error('No legacy refresh may run'); };
    const requestId = opaque();
    const response = await api.call(agent, { requestId, ...(mode === 'stale revision' ? { refresh: { connectorId: CONN, revision: opaque() } } : {}) });
    expect(response.status).toBe(200);
    const snapshot = await openResponse(response, agent, requestId);
    expect(snapshot.connectors[0]).toMatchObject({ state: 'signin', headers: {}, url: 'https://vendor.example' });
    for (const hidden of ['ACCESS_OLD', 'REFRESH_OLD', 'CLIENT_SECRET', 'URL_SECRET']) expect(JSON.stringify(snapshot)).not.toContain(hidden);
    expect(calls).toBe(0);
    expect((await secretNow()).row.secret).toBe(row.secret);
  }));

  test('an omitted refresh token is preserved, not erased by replacement access tokens', () => done(async () => {
    await seedConnector(held.db, oauthSecret());
    await assignConnector(held.db, agent);
    api.deps.fetch = () => Promise.resolve(Response.json({ access_token: 'ACCESS_NEW', expires_in: 3600 }));
    expect((await api.call(agent)).status).toBe(200);
    expect((await secretNow()).secret.tokens?.refreshToken).toBe('REFRESH_OLD');
  }));

  test('forced refresh is conditional on the prior opaque revision, stale retries do not rotate twice', () => done(async () => {
    const row = await seedConnector(held.db, oauthSecret(Date.now() + 3600_000));
    await assignConnector(held.db, agent);
    let calls = 0;
    api.deps.fetch = () => { calls += 1; return Promise.resolve(Response.json({ access_token: 'ACCESS_NEW', refresh_token: 'REFRESH_ROTATED', expires_in: 3600 })); };
    const refresh = { connectorId: CONN, revision: credentialRevision(MASTER, row) };
    expect((await api.call(agent, { requestId: opaque(), refresh: { ...refresh, revision: opaque() } })).status).toBe(200);
    expect(calls).toBe(0);
    expect((await api.call(agent, { requestId: opaque(), refresh })).status).toBe(200);
    expect((await api.call(agent, { requestId: opaque(), refresh })).status).toBe(200);
    expect(calls).toBe(1);
  }));

  test('a stale forced refresh does not override a newer sign-in generation', () => done(async () => {
    const row = await seedConnector(held.db, oauthSecret(Date.now() + 3600_000));
    await assignConnector(held.db, agent);
    const before = credentialRevision(MASTER, row);
    await held.db.update(connectors).set({ authGeneration: 'newer000001' }).where(eq(connectors.id, CONN));
    let calls = 0;
    api.deps.fetch = () => { calls += 1; return Promise.resolve(Response.json({ access_token: 'wrong' })); };
    expect((await api.call(agent, { requestId: opaque(), refresh: { connectorId: CONN, revision: before } })).status).toBe(200);
    expect(calls).toBe(0);
    expect((await secretNow()).secret.tokens?.accessToken).toBe('ACCESS_OLD');
  }));

  test('only an OAuth invalid_grant permanently disconnects, retaining client discovery without tokens', () => done(async () => {
    await seedConnector(held.db, oauthSecret());
    await assignConnector(held.db, agent);
    api.deps.fetch = () => Promise.resolve(Response.json({ error: 'invalid_grant', error_description: 'SECRET_ERROR_WITH_TOKEN' }, { status: 400 }));
    const requestId = opaque();
    const response = await api.call(agent, { requestId });
    expect(response.status).toBe(200);
    expect((await openResponse(response, agent, requestId)).connectors[0]).toMatchObject({ state: 'signin', headers: {} });
    const current = await secretNow();
    expect(current.secret.tokens).toBeUndefined();
    expect(current.secret.client.clientSecret).toBe('CLIENT_SECRET');
    expect(current.row.detail).toBeNull();
    const audit = await held.db.select().from(connectorEvents);
    expect(audit.find((event) => event.action === 'connector.signed_out')).toMatchObject({ detail: '{"name":"Calendar","reason":"invalid_grant"}' });
    expect(JSON.stringify(audit)).not.toContain('SECRET_ERROR');
    expect(JSON.stringify(audit)).not.toContain('REFRESH_OLD');
  }));

  test('transient HTTP, network and malformed token answers preserve all credentials and never deliver expired tokens', () => done(async () => {
    const row = await seedConnector(held.db, oauthSecret());
    await assignConnector(held.db, agent);
    const responses = [
      () => Promise.reject(new Error('SECRET_URL_AND_TOKEN')),
      () => Promise.resolve(Response.json({ error: 'invalid_grant' }, { status: 503 })),
      () => Promise.resolve(Response.json({ error: 'temporarily_unavailable' }, { status: 400 })),
      () => Promise.resolve(new Response('not json', { status: 200 })),
      () => Promise.resolve(Response.json({ access_token: '' })),
      () => Promise.resolve(Response.json({ access_token: 'good', refresh_token: '' })),
      () => Promise.resolve(Response.json({ access_token: 'good', expires_in: 'unknown' })),
      () => Promise.resolve(Response.json({ access_token: 'good', expires_in: -2 })),
      () => Promise.resolve(Response.json({ access_token: 'good', token_type: 'mac' })),
      () => Promise.resolve(Response.json({ access_token: 'bad\r\nheader' })),
    ];
    for (const fail of responses) {
      api.deps.fetch = fail;
      const requestId = opaque();
      const response = await api.call(agent, { requestId });
      expect(response.status).toBe(200);
      const opened = await openResponse(response, agent, requestId);
      expect(opened.connectors[0]).toMatchObject({ state: 'unavailable', headers: {} });
      expect((await secretNow()).row.secret).toBe(row.secret);
    }
    const audit = await held.db.select().from(connectorEvents);
    const failures = audit.filter((entry) => entry.action === 'connector.refresh_failed');
    expect(failures).toHaveLength(responses.length);
    expect(failures.every((entry) => entry.detail === '{"name":"Calendar","reason":"transient"}')).toBe(true);
    expect(JSON.stringify(audit)).not.toContain('SECRET_URL');
    expect(JSON.stringify(audit)).not.toContain('REFRESH_OLD');
    expect((await secretNow()).secret.tokens?.refreshToken).toBe('REFRESH_OLD');
  }));

  test('a failed forced refresh with an unexpired token delivers unavailable rather than the refused credential', () => done(async () => {
    const row = await seedConnector(held.db, oauthSecret(Date.now() + 3600_000));
    await assignConnector(held.db, agent);
    api.deps.fetch = () => Promise.reject(new Error('network'));
    const requestId = opaque();
    const opened = await openResponse(await api.call(agent, { requestId, refresh: { connectorId: CONN, revision: credentialRevision(MASTER, row) } }), agent, requestId);
    expect(opened.connectors[0]).toMatchObject({ state: 'unavailable', headers: {} });
    expect((await secretNow()).row.secret).toBe(row.secret);
  }));

  test('malformed stored expiry is never turned into a non-expiring access token', () => done(async () => {
    const row = await seedConnector(held.db, oauthSecret());
    const secret = oauthSecret();
    const corrupted = { ...secret, tokens: { accessToken: 'ACCESS_OLD', refreshToken: 'REFRESH_OLD', expiresAt: null } };
    await held.db.update(connectors).set({ secret: sealConnectorSecret(MASTER, row, corrupted as unknown as typeof secret) }).where(eq(connectors.id, CONN));
    await assignConnector(held.db, agent);
    const requestId = opaque();
    const opened = await openResponse(await api.call(agent, { requestId }), agent, requestId);
    expect(opened.connectors[0]).toMatchObject({ state: 'signin', headers: {} });
  }));
});
