import { afterEach, describe, expect, test } from 'bun:test';
import type { FetchLike } from '@metro-labs/core/stations/oauth';
import { openConnectorSecret, type ConnectorSecret } from '@metro-labs/connectors/model';
import { connectors } from '../src/db/schema.js';
import { assignConnector, enrollDeliveryAgent, latch, MASTER, newDeliveryAgent, opaque, openResponse, seedConnector, startDeliveryApi } from './connector-delivery-fixture.js';
import { postgresFixture, TEST_DATABASE_URL } from './connector-postgres-fixture.js';

const TARGET = 'https://vendor.example/SECRET_PATH/tools?key=TRANSPORT_SECRET';
const TOKEN_ENDPOINT = 'https://issuer.example/token';
const SCOPE = 'original.read original.write';

type DeliveryApi = Awaited<ReturnType<typeof startDeliveryApi>>;
let held: Awaited<ReturnType<typeof postgresFixture>> | undefined;
const apis: DeliveryApi[] = [];
const pauses: ReturnType<typeof latch>[] = [];
afterEach(async () => { for (const pause of pauses.splice(0)) pause.release(); for (const api of apis.splice(0)) await api.close(); await held?.close(); held = undefined; });

function importedSecret(expiresAt: number): Extract<ConnectorSecret, { kind: 'oauth' }> {
  return {
    kind: 'oauth', targetUrl: TARGET,
    client: { clientId: 'original-dynamic-client', clientSecret: 'ORIGINAL_CLIENT_SECRET' },
    server: { issuer: 'https://issuer.example', authorizationEndpoint: '', tokenEndpoint: TOKEN_ENDPOINT, registrationEndpoint: null, supportsS256: true, scopes: [] },
    tokens: { accessToken: 'OLD_ACCESS_SECRET', refreshToken: 'OLD_REFRESH_SECRET', resource: TARGET, expiresAt },
    imported: { state: 'owned', tokenEndpointAuthMethod: 'client_secret_post', scope: SCOPE },
  };
}

async function setup(expiresAt = 1) {
  if (TEST_DATABASE_URL === undefined) throw new Error('disposable PostgreSQL required');
  const db = held = await postgresFixture(TEST_DATABASE_URL);
  const agent = newDeliveryAgent();
  await enrollDeliveryAgent(db.db1, agent);
  await seedConnector(db.db1, importedSecret(expiresAt));
  await assignConnector(db.db1, agent);
  const forms: URLSearchParams[] = [];
  const control = { failure: false, hold: null as ReturnType<typeof latch> | null };
  const send: FetchLike = async (target, init) => {
    if (target !== TOKEN_ENDPOINT) throw new Error(`unexpected fetch to ${target}`);
    forms.push(new URLSearchParams(String(init?.body)));
    await control.hold?.pause();
    if (control.failure) throw new Error('provider-lost-rotated-SECRET');
    return Response.json({ access_token: 'ROTATED_ACCESS_SECRET', refresh_token: 'ROTATED_REFRESH_SECRET', expires_in: 3600 });
  };
  const first = await startDeliveryApi(db.db1, { fetch: send }); apis.push(first);
  const second = await startDeliveryApi(db.db2, { fetch: send }); apis.push(second);
  const stored = async () => {
    const row = (await db.db2.select().from(connectors))[0];
    if (row === undefined) throw new Error('connector missing');
    return { row, secret: openConnectorSecret(MASTER, row) };
  };
  const request = (api: DeliveryApi) => {
    const requestId = opaque();
    return { requestId, response: api.call(agent, { requestId }) };
  };
  const delivered = async (api: DeliveryApi) => {
    const { requestId, response } = request(api);
    const res = await response;
    expect(res.status).toBe(200);
    return (await openResponse(res, agent, requestId)).connectors[0];
  };
  return { db, agent, first, second, stored, request, delivered, forms, control };
}

describe.skipIf(TEST_DATABASE_URL === undefined)('durable imported OAuth grant refresh across PostgreSQL connections', () => {
  test('two independent delivery processes refresh an expired imported grant exactly once and keep its binding', async () => {
    const f = await setup();
    f.control.hold = latch(); pauses.push(f.control.hold);
    const one = f.request(f.first);
    await f.control.hold.reached;
    const during = await f.stored();
    expect(during.secret?.kind === 'oauth' ? during.secret.imported?.state : null).toBe('refreshing');
    const two = f.request(f.second);
    await f.db.waiting('two');
    expect(f.forms).toHaveLength(1);
    f.control.hold.release();
    const [left, right] = await Promise.all([one.response, two.response]);
    expect((await openResponse(left, f.agent, one.requestId)).connectors[0]).toMatchObject({ state: 'ready', headers: { Authorization: 'Bearer ROTATED_ACCESS_SECRET' } });
    expect((await openResponse(right, f.agent, two.requestId)).connectors[0]).toMatchObject({ state: 'ready', headers: { Authorization: 'Bearer ROTATED_ACCESS_SECRET' } });
    expect(f.forms).toHaveLength(1);
    expect(Object.fromEntries(f.forms[0] ?? [])).toEqual({ grant_type: 'refresh_token', refresh_token: 'OLD_REFRESH_SECRET', resource: TARGET, scope: SCOPE, client_id: 'original-dynamic-client', client_secret: 'ORIGINAL_CLIENT_SECRET' });
    const { secret } = await f.stored();
    if (secret?.kind !== 'oauth') throw new Error('grant missing');
    expect(secret.tokens).toMatchObject({ accessToken: 'ROTATED_ACCESS_SECRET', refreshToken: 'ROTATED_REFRESH_SECRET', resource: TARGET });
    expect(secret.imported).toEqual({ state: 'owned', tokenEndpointAuthMethod: 'client_secret_post', scope: SCOPE });
    expect(secret.client).toEqual({ clientId: 'original-dynamic-client', clientSecret: 'ORIGINAL_CLIENT_SECRET' });
    expect(secret.server.issuer).toBe('https://issuer.example');
    const bytes = JSON.stringify(await f.db.db1.select().from(connectors));
    for (const text of ['OLD_ACCESS_SECRET', 'OLD_REFRESH_SECRET', 'ROTATED_ACCESS_SECRET', 'ROTATED_REFRESH_SECRET', 'ORIGINAL_CLIENT_SECRET', 'SECRET_PATH', 'TRANSPORT_SECRET']) expect(bytes).not.toContain(text);
  }, 20_000);

  test('a live imported grant needs no refresh', async () => {
    const f = await setup(Date.now() + 3600_000);
    expect(await f.delivered(f.first)).toMatchObject({ state: 'ready', headers: { Authorization: 'Bearer OLD_ACCESS_SECRET' } });
    expect(await f.delivered(f.second)).toMatchObject({ state: 'ready', headers: { Authorization: 'Bearer OLD_ACCESS_SECRET' } });
    expect(f.forms).toHaveLength(0);
    expect((await f.stored()).secret).toMatchObject({ tokens: { accessToken: 'OLD_ACCESS_SECRET' }, imported: { state: 'owned' } });
  });

  test('an ambiguous provider refresh is durable and never repeated on a later delivery', async () => {
    const f = await setup();
    f.control.failure = true;
    expect((await f.delivered(f.first))?.state).toBe('unavailable');
    for (const api of [f.second, f.first]) expect((await f.delivered(api))?.state).toBe('unavailable');
    expect(f.forms).toHaveLength(1);
    expect((await f.stored()).secret).toMatchObject({ imported: { state: 'uncertain' } });
  });

  test('a process lost after provider rotation but before the commit keeps the intent, not a second refresh', async () => {
    const f = await setup();
    const store = f.first.deps.store;
    f.first.deps.store = { ...store, refresh: (identity, id, at, edit) => store.refresh(identity, id, at, async (current) => {
      const edited = await edit(current);
      const before = openConnectorSecret(MASTER, current.connector);
      const secret = edited.change.secret;
      const after = secret === undefined || secret === null ? null : openConnectorSecret(MASTER, { ...current.connector, secret });
      if (before?.kind === 'oauth' && before.imported?.state === 'refreshing' && after?.kind === 'oauth' && after.imported?.state === 'owned') throw new Error('fixture process lost before commit');
      return edited;
    }) };
    expect((await f.request(f.first).response).status).toBe(503);
    expect(f.forms).toHaveLength(1);
    expect((await f.stored()).secret).toMatchObject({ imported: { state: 'refreshing' } });
    expect((await f.delivered(f.second))?.state).toBe('unavailable');
    expect(f.forms).toHaveLength(1);
    expect((await f.stored()).secret).toMatchObject({ imported: { state: 'refreshing' } });
  });

  test('a process lost after the durable refresh intent but before dispatch does not guess whether the token was used', async () => {
    const f = await setup();
    const store = f.first.deps.store;
    f.first.deps.store = { ...store, refresh: async (identity, id, at, edit) => {
      await store.refresh(identity, id, at, edit);
      const { secret } = await f.stored();
      if (secret?.kind === 'oauth' && secret.imported?.state === 'refreshing') throw new Error('fixture process lost after intent commit');
    } };
    expect((await f.request(f.first).response).status).toBe(503);
    expect(f.forms).toHaveLength(0);
    expect((await f.delivered(f.second))?.state).toBe('unavailable');
    expect(f.forms).toHaveLength(0);
    expect((await f.stored()).secret).toMatchObject({ imported: { state: 'refreshing' } });
  });
});
