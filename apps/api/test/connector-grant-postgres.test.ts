import { afterEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { portableGrant } from '@metro-labs/http/connector-grant';
import { openConnectorSecret, sealConnectorSecret } from '../src/connectors/model.js';
import { connectorAgents, connectorMigrations, connectors } from '../src/db/schema.js';
import { answer, input, payload, prepareInput, startMigrationApi, verifiedFetch, type MigrationApi } from './connector-migration-fixture.js';
import { enrollDeliveryAgent, latch, MASTER, newDeliveryAgent, startDeliveryApi, openResponse, opaque } from './connector-delivery-fixture.js';
import { postgresFixture, TEST_DATABASE_URL } from './connector-postgres-fixture.js';

let held: Awaited<ReturnType<typeof postgresFixture>> | undefined;
const apis: MigrationApi[] = [];
const pauses: ReturnType<typeof latch>[] = [];
afterEach(async () => { for (const pause of pauses.splice(0)) pause.release(); for (const api of apis.splice(0)) await api.close(); await held?.close(); held = undefined; });

async function setup(expiresAt = 1) {
  if (TEST_DATABASE_URL === undefined) throw new Error('disposable PostgreSQL required');
  const db = held = await postgresFixture(TEST_DATABASE_URL);
  const agent = newDeliveryAgent();
  await enrollDeliveryAgent(db.db1, agent);
  const url = 'https://vendor.example/SECRET_PATH/tools?key=TRANSPORT_SECRET';
  const grant = portableGrant({ kind: 'oauth', accessToken: 'OLD_ACCESS_SECRET', refreshToken: 'OLD_REFRESH_SECRET', clientId: 'original-dynamic-client', clientSecret: 'ORIGINAL_CLIENT_SECRET', issuer: 'https://issuer.example', tokenEndpoint: 'https://issuer.example/token', scope: 'original.read original.write', resource: url, expiresAt }, url);
  const source = payload({ url, auth: { kind: 'oauth', grant }, client: null });
  const forms: URLSearchParams[] = [];
  const control = { failure: false, hold: null as ReturnType<typeof latch> | null };
  const send = async (target: string, init?: RequestInit): Promise<Response> => {
    if (target !== grant.tokenEndpoint) return verifiedFetch(target, init);
    forms.push(new URLSearchParams(String(init?.body)));
    await control.hold?.pause();
    if (control.failure) throw new Error('provider-lost-rotated-SECRET');
    expect(forms.at(-1)?.get('refresh_token')).toBe('OLD_REFRESH_SECRET');
    return Response.json({ access_token: 'ROTATED_ACCESS_SECRET', refresh_token: 'ROTATED_REFRESH_SECRET', expires_in: 3600 });
  };
  const first = await startMigrationApi(db.db1, { fetch: send }); apis.push(first);
  const second = await startMigrationApi(db.db2, { fetch: send }); apis.push(second);
  const begin = await answer(await first.call(agent, input('begin')));
  const request = { ...prepareInput(begin, source), action: 'handover' };
  const stored = async () => {
    const row = (await db.db2.select().from(connectors))[0];
    if (row === undefined) throw new Error('destination missing');
    return { row, secret: openConnectorSecret(MASTER, row) };
  };
  return { db, agent, first, second, begin, request, stored, forms, control, grant };
}

describe.skipIf(TEST_DATABASE_URL === undefined)('durable imported OAuth grant refresh across PostgreSQL connections', () => {
  test('commit ownership before refresh, rotate exactly once across concurrent handovers and retain binding', async () => {
    const f = await setup();
    f.control.hold = latch(); pauses.push(f.control.hold);
    const pending = f.first.call(f.agent, f.request);
    await f.control.hold.reached;
    const during = await f.stored();
    expect(during.secret?.kind === 'oauth' ? during.secret.imported?.state : null).toBe('refreshing');
    const retry = f.second.call(f.agent, f.request);
    await f.db.waiting('two');
    expect(f.forms).toHaveLength(1);
    f.control.hold.release();
    const results = await Promise.all([pending, retry]);
    for (const response of results) expect((await answer(response)).migration).toMatchObject({ phase: 'prepared', readiness: 'ready', grantImported: true });
    expect(f.forms).toHaveLength(1);
    expect(Object.fromEntries(f.forms[0] ?? [])).toEqual({ grant_type: 'refresh_token', refresh_token: 'OLD_REFRESH_SECRET', resource: f.grant.resource, scope: f.grant.scope, client_id: f.grant.clientId, client_secret: f.grant.clientSecret });
    const { secret } = await f.stored();
    if (secret?.kind !== 'oauth') throw new Error('grant missing');
    expect(secret.tokens).toMatchObject({ accessToken: 'ROTATED_ACCESS_SECRET', refreshToken: 'ROTATED_REFRESH_SECRET', resource: f.grant.resource });
    expect(secret.client).toEqual({ clientId: f.grant.clientId, clientSecret: f.grant.clientSecret });
    expect(secret.server.issuer).toBe(f.grant.issuer);
    expect((await f.first.call(f.agent, input('rollback'))).status).toBe(409);
    expect((await answer(await f.second.call(f.agent, input('activate')))).migration.phase).toBe('active');
    expect(await f.db.db1.$count(connectors)).toBe(1);
    expect(await f.db.db1.$count(connectorAgents)).toBe(1);
    const bytes = JSON.stringify({ rows: await f.db.db1.select().from(connectors), mappings: await f.db.db1.select().from(connectorMigrations) });
    for (const text of ['OLD_ACCESS_SECRET', 'OLD_REFRESH_SECRET', 'ROTATED_ACCESS_SECRET', 'ROTATED_REFRESH_SECRET', 'ORIGINAL_CLIENT_SECRET', 'SECRET_PATH', 'TRANSPORT_SECRET']) expect(bytes).not.toContain(text);
  }, 20_000);

  test('active access needs neither refresh, discovery nor registration', async () => {
    const f = await setup(Date.now() + 3600_000);
    expect((await answer(await f.first.call(f.agent, f.request))).migration.readiness).toBe('ready');
    expect((await answer(await f.second.call(f.agent, f.request))).migration.readiness).toBe('ready');
    expect(f.forms).toHaveLength(0);
    expect((await f.stored()).secret).toMatchObject({ tokens: { accessToken: 'OLD_ACCESS_SECRET' }, imported: { state: 'owned' } });
  });

  test('ambiguous provider refresh is durable and never automatically repeated on status or retry', async () => {
    const f = await setup();
    f.control.failure = true;
    expect((await answer(await f.first.call(f.agent, f.request))).migration.readiness).toBe('refresh_uncertain');
    for (const request of [input('status'), f.request, input('status')]) {
      const result = await answer(await f.second.call(f.agent, request));
      expect(result.migration.readiness).toBe('refresh_uncertain');
      expect(JSON.stringify(result)).not.toContain('SECRET');
    }
    expect(f.forms).toHaveLength(1);
    expect((await f.second.call(f.agent, input('activate'))).status).toBe(409);
    expect((await f.second.call(f.agent, input('rollback'))).status).toBe(409);
    expect((await f.stored()).secret).toMatchObject({ imported: { state: 'uncertain' } });
  });

  test('process loss after provider rotation but before DB commit retains intent, not a second refresh', async () => {
    const f = await setup();
    const store = f.first.deps.migrations;
    f.first.deps.migrations = { ...store, change: (identity, request, edit) => store.change(identity, request, async (state) => {
      const change = await edit(state);
      if (state.connector !== null && change.connector?.secret !== undefined) {
        const before = openConnectorSecret(MASTER, state.connector);
        const after = openConnectorSecret(MASTER, { ...state.connector, secret: change.connector.secret });
        if (before?.kind === 'oauth' && before.imported?.state === 'refreshing' && after?.kind === 'oauth' && after.imported?.state === 'owned') throw new Error('fixture process lost before commit');
      }
      return change;
    }) };
    expect((await f.first.call(f.agent, f.request)).status).toBe(409);
    expect((await f.stored()).secret).toMatchObject({ imported: { state: 'refreshing' } });
    expect((await answer(await f.second.call(f.agent, input('status')))).migration.readiness).toBe('refresh_uncertain');
    expect((await answer(await f.second.call(f.agent, f.request))).migration.readiness).toBe('refresh_uncertain');
    expect(f.forms).toHaveLength(1);
    expect(await f.db.db1.$count(connectorAgents)).toBe(0);
  });

  test('unknown auth methods and private provider endpoints fail before a credential envelope exists', async () => {
    const f = await setup();
    for (const change of [{ tokenEndpointAuthMethod: 'private_key_jwt' }, { tokenEndpointAuthMethod: 'client_secret_basic' }, { tokenEndpoint: 'https://127.0.0.1/token' }, { resource: 'https://another.example/mcp' }, { dpopKey: 'SECRET_BOUND_KEY' }]) {
      expect(() => portableGrant({ ...f.grant, ...change }, f.grant.resource)).toThrow();
    }
    expect(await f.db.db1.$count(connectors)).toBe(0);
    expect(await f.db.db1.$count(connectorMigrations, eq(connectorMigrations.phase, 'preparing'))).toBe(1);
  });
  test('after cutover two independent delivery processes refresh the imported grant only once', async () => {
    const f = await setup(Date.now() + 3600_000);
    await answer(await f.first.call(f.agent, f.request));
    await answer(await f.first.call(f.agent, input('activate')));
    const { row, secret } = await f.stored();
    if (secret?.kind !== 'oauth' || secret.tokens === undefined) throw new Error('grant missing');
    await f.db.db1.update(connectors).set({ secret: sealConnectorSecret(MASTER, row, { ...secret, tokens: { ...secret.tokens, expiresAt: 1 } }) }).where(eq(connectors.id, row.id));
    f.control.hold = latch(); pauses.push(f.control.hold);
    const one = await startDeliveryApi(f.db.db1, { fetch: f.first.deps.fetch });
    const two = await startDeliveryApi(f.db.db2, { fetch: f.second.deps.fetch });
    try {
      const a = opaque(); const b = opaque();
      const pending = one.call(f.agent, { requestId: a });
      await f.control.hold.reached;
      const concurrent = two.call(f.agent, { requestId: b });
      await f.db.waiting('two');
      expect(f.forms).toHaveLength(1);
      f.control.hold.release();
      const [left, right] = await Promise.all([pending, concurrent]);
      expect((await openResponse(left, f.agent, a)).connectors[0]?.headers).toEqual({ Authorization: 'Bearer ROTATED_ACCESS_SECRET' });
      expect((await openResponse(right, f.agent, b)).connectors[0]?.headers).toEqual({ Authorization: 'Bearer ROTATED_ACCESS_SECRET' });
      expect(f.forms).toHaveLength(1);
      expect((await f.stored()).secret).toMatchObject({ tokens: { refreshToken: 'ROTATED_REFRESH_SECRET' }, imported: { state: 'owned' } });
    } finally { f.control.hold.release(); await one.close(); await two.close(); }
  }, 20_000);

  test('loss after durable refresh intent but before dispatch does not guess whether the token was used', async () => {
    const f = await setup();
    const store = f.first.deps.migrations;
    f.first.deps.migrations = { ...store, change: async (identity, request, edit) => {
      const state = await store.change(identity, request, edit);
      const secret = state.connector === null ? null : openConnectorSecret(MASTER, state.connector);
      if (secret?.kind === 'oauth' && secret.imported?.state === 'refreshing') throw new Error('fixture process lost after intent commit');
      return state;
    } };
    expect((await f.first.call(f.agent, f.request)).status).toBe(409);
    expect(f.forms).toHaveLength(0);
    expect((await answer(await f.second.call(f.agent, f.request))).migration.readiness).toBe('refresh_uncertain');
    expect(f.forms).toHaveLength(0);
  });

});
