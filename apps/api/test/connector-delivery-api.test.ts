import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { CONNECTOR_DELIVERY_LEASE_MS } from '@metro-labs/http/connector-delivery';
import { AgentAuth } from '../src/agents/auth.js';
import { credentialRevision } from '../src/connectors/delivery-model.js';
import { openConnectorSecret } from '../src/connectors/model.js';
import { readConnectorsSetup } from '../src/connectors/setup.js';
import { agents, agentNonces, connectorAgents, connectorEvents, connectors } from '../src/db/schema.js';
import { TEST_OWNER, TEST_STRANGER } from './identity-helper.js';
import { PGLITE_START_MS, PGLITE_STEP_MS, testDb, type TestDb } from './pglite-db.js';
import { CONN, HOST, MASTER, PATH, assignConnector, enrollDeliveryAgent, newDeliveryAgent, oauthSecret, opaque, openResponse, seedConnector, signedDelivery, startDeliveryApi, type DeliveryAgent } from './connector-delivery-fixture.js';

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

describe('signed connector delivery boundary', () => {
  test('only the signed agent assigned same-organization rows are queried and sealed', () => done(async () => {
    const other = newDeliveryAgent('agent000002');
    const stranger = newDeliveryAgent('agent000003', TEST_STRANGER);
    await enrollDeliveryAgent(held.db, other);
    await enrollDeliveryAgent(held.db, stranger);
    const secret = { kind: 'header' as const, targetUrl: 'https://vendor.example/private?key=URL_SECRET', name: 'Authorization', value: 'Bearer API_KEY' };
    const own = await seedConnector(held.db, secret);
    await seedConnector(held.db, { kind: 'none', targetUrl: 'https://notassigned.example/mcp' }, { id: 'conn0000002', name: 'Not assigned' });
    await seedConnector(held.db, secret, { id: 'conn0000003', name: 'Other organization', owner: TEST_STRANGER });
    await assignConnector(held.db, agent);
    await assignConnector(held.db, other, 'conn0000002');
    await assignConnector(held.db, agent, 'conn0000003');
    const requestId = opaque();
    const res = await api.call(agent, { requestId });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const text = await res.clone().text();
    for (const hidden of ['API_KEY', 'URL_SECRET', own.secret ?? '', 'notassigned.example', 'Other organization']) expect(text).not.toContain(hidden);
    const opened = await openResponse(res, agent, requestId);
    expect(opened.expiresAt - opened.issuedAt).toBe(CONNECTOR_DELIVERY_LEASE_MS);
    expect(opened.connectors).toEqual([{ id: CONN, name: 'Calendar', url: secret.targetUrl, auth: 'header', state: 'ready', headers: { Authorization: 'Bearer API_KEY' }, policy: {}, revision: credentialRevision(MASTER, own) }]);
    const strangerId = opaque();
    expect((await openResponse(await api.call(stranger, { requestId: strangerId }), stranger, strangerId)).connectors).toEqual([]);
    const delivered = await held.db.select().from(connectorEvents).where(eq(connectorEvents.action, 'connector.delivered'));
    expect(delivered.map((event) => [event.connector, event.agent, event.owner, event.detail])).toEqual([[CONN, agent.row.agent, TEST_OWNER, '{"name":"Calendar"}']]);
  }));

  test('both independent switches are required, off requests spend nothing', () => done(async () => {
    for (const [enabled, deliveryEnabled] of [[false, false], [false, true], [true, false]]) {
      api.deps.enabled = () => enabled ?? false;
      api.deps.deliveryEnabled = () => deliveryEnabled ?? false;
      expect((await api.call(agent)).status).toBe(503);
    }
    expect(await held.db.select().from(agentNonces)).toEqual([]);
    expect(readConnectorsSetup({ METRO_CONNECTORS_DELIVERY_ENABLED: 'true' }).deliveryEnabled).toBe(false);
    expect(readConnectorsSetup({ METRO_CONNECTORS_ENABLED: 'true' }).deliveryEnabled).toBe(false);
    expect(readConnectorsSetup({ METRO_CONNECTORS_ENABLED: 'true', METRO_CONNECTORS_DELIVERY_ENABLED: 'true' }).deliveryEnabled).toBe(true);
  }));

  test('browser, bearer, unsigned, stale and forged requests cannot deliver or refresh', () => done(async () => {
    await seedConnector(held.db, oauthSecret());
    await assignConnector(held.db, agent);
    let calls = 0;
    api.deps.fetch = () => { calls += 1; return Promise.resolve(Response.json({ access_token: 'bad' })); };
    expect((await api.call(agent, { requestId: opaque() }, { authorization: 'Bearer browser' })).status).toBe(401);
    for (const name of ['origin', 'sec-fetch-site', 'sec-fetch-dest', 'sec-fetch-user']) expect((await api.call(agent, { requestId: opaque() }, { [name]: 'browser' })).status).toBe(403);
    const body = { requestId: opaque() };
    for (const request of [signedDelivery(agent, body, Date.now() - 360_000), signedDelivery(agent, body, Date.now(), PATH, 'attacker.example'), signedDelivery(agent, body, Date.now(), '/wrong')]) {
      expect((await fetch(`${api.base}${PATH}`, { method: 'POST', ...request })).status).toBe(401);
    }
    expect((await fetch(`${api.base}${PATH}`, { method: 'POST', body: JSON.stringify(body) })).status).toBe(401);
    expect((await fetch(`${api.base}${PATH}`)).status).toBe(405);
    expect(calls).toBe(0);
    expect(await held.db.select().from(agentNonces)).toEqual([]);
    expect(await held.db.$count(connectorEvents, eq(connectorEvents.action, 'connector.delivered'))).toBe(0);
  }));

  test('whole request bodies are strictly checked and bounded before side effects', () => done(async () => {
    const good = opaque();
    for (const input of [null, [], {}, { requestId: 'x'.repeat(43) }, { requestId: good, owner: TEST_OWNER }, { requestId: good, refresh: null }, { requestId: good, refresh: { connectorId: CONN, accessToken: 'TOKEN' } }, { requestId: good, refresh: { connectorId: 'bad', revision: good } }, { requestId: good, refresh: { connectorId: CONN, revision: good, extra: true } }]) expect((await api.call(agent, input)).status).toBe(400);
    expect((await api.call(agent, { requestId: 'a'.repeat(5000) })).status).toBe(413);
    expect(await held.db.select().from(agentNonces)).toEqual([]);
  }));

  test('replay is durable across AgentAuth instances and restarts without duplicate delivery audit', () => done(async () => {
    await seedConnector(held.db, { kind: 'none', targetUrl: 'https://vendor.example/mcp' });
    await assignConnector(held.db, agent);
    const request = signedDelivery(agent, { requestId: opaque() });
    expect((await fetch(`${api.base}${PATH}`, { method: 'POST', ...request })).status).toBe(200);
    api.deps.auth = new AgentAuth(HOST, Date.now);
    expect((await fetch(`${api.base}${PATH}`, { method: 'POST', ...request })).status).toBe(401);
    const second = await startDeliveryApi(held.db);
    try { expect((await fetch(`${second.base}${PATH}`, { method: 'POST', ...request })).status).toBe(401); } finally { await second.close(); }
    expect((await held.db.select().from(agentNonces)).length).toBe(1);
    expect(await held.db.$count(connectorEvents, eq(connectorEvents.action, 'connector.delivered'))).toBe(1);
  }));

  test('missing keys keep their machine-readable code, moved and deleted agents fail closed', () => done(async () => {
    await held.db.update(agents).set({ owner: TEST_STRANGER }).where(eq(agents.id, agent.row.agent));
    const moved = await api.call(agent);
    expect(moved.status).toBe(401);
    expect(await moved.json()).toMatchObject({ code: 'agent_key_missing' });
    await held.db.delete(agents).where(eq(agents.id, agent.row.agent));
    expect((await api.call(agent)).status).toBe(401);
  }));
});

describe('delivered credential and policy limits', () => {
  test('only access tokens are delivered, vendor expiry stays separate from the lease', () => done(async () => {
    const expiresAt = Date.now() + 3600_000;
    await seedConnector(held.db, oauthSecret(expiresAt));
    await assignConnector(held.db, agent, CONN, '{"write":"deny"}');
    const requestId = opaque();
    const opened = await openResponse(await api.call(agent, { requestId }), agent, requestId);
    expect(opened.connectors[0]).toMatchObject({ state: 'ready', expiresAt, headers: { Authorization: 'Bearer ACCESS_OLD' }, policy: { write: 'deny' } });
    const text = JSON.stringify(opened);
    for (const secret of ['REFRESH_OLD', 'CLIENT_SECRET', 'tokenEndpoint', 'clientId', 'authorizationEndpoint']) expect(text).not.toContain(secret);
    expect(expiresAt).toBeGreaterThan(opened.expiresAt);
  }));

  test('assignment read-only caps named tools and corrupt stored policies deliver no credential', () => done(async () => {
    await seedConnector(held.db, oauthSecret(Date.now() + 3600_000), { policy: '{"read":"ask","tools":{"send":"allow"}}' });
    await assignConnector(held.db, agent, CONN, '{"write":"deny"}');
    let requestId = opaque();
    let opened = await openResponse(await api.call(agent, { requestId }), agent, requestId);
    expect(opened.connectors[0]?.policy).toEqual({ read: 'ask', write: 'deny', tools: { send: 'deny' } });
    await held.db.update(connectorAgents).set({ policy: '{"write":"bogus"}' });
    requestId = opaque();
    opened = await openResponse(await api.call(agent, { requestId }), agent, requestId);
    expect(opened.connectors[0]).toMatchObject({ state: 'unavailable', headers: {}, policy: { read: 'deny', write: 'deny' }, url: 'https://vendor.example' });
    expect(JSON.stringify(opened)).not.toContain('URL_SECRET');
    await held.db.update(connectorAgents).set({ policy: null });
    await held.db.update(connectors).set({ policy: 'garbage' });
    requestId = opaque();
    expect((await openResponse(await api.call(agent, { requestId }), agent, requestId)).connectors[0]?.state).toBe('unavailable');
  }));

  test('expired unrefreshable tokens become signin and expired transient tokens are unavailable', () => done(async () => {
    const secret = oauthSecret();
    if (secret.tokens === undefined) throw new Error('missing fixture');
    delete secret.tokens.refreshToken;
    await seedConnector(held.db, secret);
    await assignConnector(held.db, agent);
    const requestId = opaque();
    const opened = await openResponse(await api.call(agent, { requestId }), agent, requestId);
    expect(opened.connectors[0]).toMatchObject({ state: 'signin', headers: {} });
    expect(JSON.stringify(opened)).not.toContain('ACCESS_OLD');
  }));

  test('snapshot oversize fails explicitly instead of silently truncating assigned connectors', () => done(async () => {
    for (let index = 0; index < 60; index += 1) {
      const id = `conn${String(index).padStart(7, '0')}`;
      const secret = oauthSecret(Date.now() + 3600_000);
      if (secret.tokens === undefined) throw new Error('missing fixture');
      secret.tokens.accessToken = 'a'.repeat(16_000);
      await seedConnector(held.db, secret, { id, name: `Connector ${String(index)}` });
      await assignConnector(held.db, agent, id);
    }
    const response = await api.call(agent);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'Connector delivery is too large.' });
    expect(await held.db.$count(connectorAgents)).toBe(60);
    expect(await held.db.$count(connectorEvents, eq(connectorEvents.action, 'connector.delivered'))).toBe(0);
  }));

  test('successful delivery writes only safe audit metadata and preserves its name after rename or delete', () => done(async () => {
    const original = await seedConnector(held.db, oauthSecret(Date.now() + 3600_000));
    await assignConnector(held.db, agent);
    expect((await api.call(agent)).status).toBe(200);
    expect((await held.db.select().from(connectors))[0]?.secret).toBe(original.secret);
    const events = await held.db.select().from(connectorEvents);
    expect(events.map((row) => row.action)).toEqual(['agent.enrolled', 'connector.delivered']);
    const delivered = events.find((row) => row.action === 'connector.delivered');
    expect(delivered).toMatchObject({ owner: TEST_OWNER, connector: CONN, agent: agent.row.agent, actor: `agent:${agent.row.agent}`, detail: '{"name":"Calendar"}' });
    const text = JSON.stringify(delivered);
    for (const hidden of ['ACCESS_OLD', 'REFRESH_OLD', 'CLIENT_SECRET', 'URL_SECRET', 'Authorization', original.secret ?? '']) expect(text).not.toContain(hidden);
    await held.db.update(connectors).set({ name: 'Renamed' }).where(eq(connectors.id, CONN));
    await held.db.delete(connectors).where(eq(connectors.id, CONN));
    expect((await held.db.select().from(connectorEvents).where(eq(connectorEvents.action, 'connector.delivered')))[0]?.detail).toBe('{"name":"Calendar"}');
    expect(openConnectorSecret(MASTER, original)?.kind).toBe('oauth');
  }));
});
