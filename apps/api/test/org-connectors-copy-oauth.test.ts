import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { newId } from '@metro-labs/core/ids';
import { detailOf, openConnectorSecret, sealConnectorSecret, type ConnectorSecret, type ImportedGrant } from '@metro-labs/connectors/model';
import type { ConnectorRow } from '@metro-labs/connectors/db/connectors';
import type { ConnectorView } from '../src/connectors/model.ts';
import { auth, TEST_OWNER, TEST_STRANGER } from './identity-helper.ts';
import { PGLITE_START_MS, PGLITE_STEP_MS, testDb, type TestDb } from './pglite-db.ts';
import { ACCESS, CALLBACK, challengeOf, REFRESH, RETURN_TO, startApi, startVendor, type Api, type Vendor } from './org-connectors-fixture.ts';

const KEY = Buffer.alloc(32, 23);
type OAuth = Extract<ConnectorSecret, { kind: 'oauth' }>;
let held: TestDb;
let vendor: Vendor;
let api: Api;
let now = Date.parse('2026-10-23T04:00:00Z');

const post = async (path: string, body: unknown, organization = TEST_OWNER): Promise<Response> =>
  fetch(`${api.base}/api/connectors/${path}`, { method: 'POST', headers: { authorization: await auth(organization), 'content-type': 'application/json' }, body: JSON.stringify(body) });

function configuration(): OAuth {
  return {
    kind: 'oauth', targetUrl: `${vendor.base}/oauth?private=url-secret-fixture`,
    client: { clientId: 'manual-client-fixture', clientSecret: 'client-secret-fixture' },
    server: { issuer: vendor.base, authorizationEndpoint: `${vendor.base}/authorize`, tokenEndpoint: `${vendor.base}/token`, registrationEndpoint: `${vendor.base}/register`, supportsS256: true, scopes: ['read'] },
    oauthResource: `${vendor.base}/oauth`,
    tokens: { accessToken: 'source-access-fixture', refreshToken: 'source-refresh-fixture', expiresAt: now - 1, resource: `${vendor.base}/oauth` },
  };
}

async function seed(secret: OAuth): Promise<ConnectorRow> {
  const row: ConnectorRow = {
    id: newId(), owner: TEST_OWNER, name: 'OAuth source', url: vendor.base, auth: 'oauth', authGeneration: newId(), policy: '{"read":"ask","tools":{"remove":"deny"}}', secret: null,
    detail: JSON.stringify({ signedInAt: '2026-10-22T01:00:00.000Z', verifiedAt: '2026-10-22T01:00:00.000Z', clientId: secret.client.clientId, issuer: vendor.base, server: 'Original vendor' }),
    createdBy: 'user_original', createdAt: '2026-10-22T01:00:00.000Z', updatedAt: '2026-10-22T01:00:00.000Z',
  };
  row.secret = sealConnectorSecret(KEY, row, secret);
  await api.deps.store.create(row);
  return row;
}

async function copy(source: ConnectorRow): Promise<{ row: ConnectorRow; secret: OAuth }> {
  const response = await post(`${source.id}/copy`, { organization: TEST_STRANGER, name: 'OAuth destination', shareCredentials: true });
  expect(response.status).toBe(201);
  const text = await response.text();
  for (const privateValue of ['source-access-fixture', 'source-refresh-fixture', 'client-secret-fixture', 'url-secret-fixture', 'source-attempt-fixture']) expect(text).not.toContain(privateValue);
  const body = JSON.parse(text) as { organization: string; connector: ConnectorView };
  expect(body).toMatchObject({ organization: TEST_STRANGER, connector: { auth: 'oauth', signIn: 'disconnected', verifiedAt: null, clientId: 'manual-client-fixture', agents: [], policy: { read: 'ask', tools: { remove: 'deny' } } } });
  expect(body).not.toHaveProperty('authorizeUrl');
  const row = await api.deps.store.find(TEST_STRANGER, body.connector.id);
  if (row === null) throw new Error('missing copied row');
  const secret = openConnectorSecret(KEY, row);
  if (secret?.kind !== 'oauth') throw new Error('missing copied OAuth setup');
  expect(secret).not.toHaveProperty('tokens');
  expect(detailOf(row.detail)).not.toHaveProperty('signedInAt');
  expect(row.authGeneration).not.toBe(source.authGeneration);
  expect(await api.deps.store.find(TEST_OWNER, source.id)).toEqual(source);
  return { row, secret };
}

async function signIn(row: ConnectorRow): Promise<void> {
  const response = await post(`${row.id}/sign-in`, { returnTo: RETURN_TO }, TEST_STRANGER);
  expect(response.status).toBe(200);
  const { authorizeUrl } = await response.json() as { authorizeUrl: string };
  const { state, challenge, resource, clientId } = challengeOf(authorizeUrl);
  expect(resource).toBe(`${vendor.base}/oauth`);
  expect(clientId).toBe('manual-client-fixture');
  vendor.challenges.set('destination-code', challenge);
  const callback = await fetch(`${api.base}/api/connectors/callback?state=${state}&code=destination-code`, { redirect: 'manual' });
  expect(callback.status).toBe(302);
  const location = new URL(callback.headers.get('location') ?? '');
  expect(location.hash.split('?')[0]).toBe(`#/${TEST_STRANGER}/organization/connectors/${row.id}`);
  const handoff = new URLSearchParams(location.hash.split('?')[1]).get('org_connector');
  const completed = await post('complete', { handoff }, TEST_STRANGER);
  expect(completed.status).toBe(200);
  expect(await completed.json()).toMatchObject({ id: row.id, signIn: 'connected' });
  const current = await api.deps.store.find(TEST_STRANGER, row.id);
  if (current === null) throw new Error('missing signed-in copy');
  const secret = openConnectorSecret(KEY, current);
  if (secret?.kind !== 'oauth') throw new Error('missing signed-in configuration');
  expect(secret.tokens).toMatchObject({ accessToken: ACCESS, refreshToken: REFRESH, resource: `${vendor.base}/oauth` });
  expect(vendor.tokenForms.at(-1)?.get('grant_type')).toBe('authorization_code');
  expect(vendor.tokenForms.at(-1)?.get('client_secret')).toBe('client-secret-fixture');
  expect(vendor.tokenForms.at(-1)?.get('redirect_uri')).toBe(CALLBACK);
}

beforeAll(async () => {
  held = await testDb();
  vendor = await startVendor();
  api = await startApi(() => held.db, () => now, vendor.fetch);
}, PGLITE_START_MS);

beforeEach(async () => {
  now += 60_000;
  await held.reset();
  api.setKey(KEY);
  api.deps.organizations = () => Promise.resolve([{ id: TEST_OWNER, role: 'admin' }, { id: TEST_STRANGER, role: 'admin' }]);
  vendor.requests.length = 0;
  vendor.tokenForms.length = 0;
  vendor.tokenCalls = 0;
  vendor.registrations = 0;
}, PGLITE_STEP_MS);

afterAll(async () => {
  await api.close();
  await vendor.close();
  await held.close();
});

describe('OAuth copies start without a user grant', () => {
  test('native OAuth preserves the internal client and public resource, then signs in independently without touching the source', async () => {
    const original = configuration();
    const source = await seed(original);
    const destination = await copy(source);
    const { tokens: _tokens, ...setup } = original;
    expect(destination.secret).toEqual(setup);
    expect(vendor.requests).toEqual([]);
    await signIn(destination.row);
    expect(vendor.registrations).toBe(0);
    expect(vendor.tokenCalls).toBe(1);
    expect(await api.deps.store.find(TEST_OWNER, source.id)).toEqual(source);
    expect(openConnectorSecret(KEY, source)).toEqual(original);
  });

  test('an older native grant keeps its public resource binding, but not its tokens', async () => {
    const original = configuration();
    delete original.oauthResource;
    const source = await seed(original);
    const destination = await copy(source);
    expect(destination.secret.oauthResource).toBe(`${vendor.base}/oauth`);
    expect(destination.secret).not.toHaveProperty('imported');
    expect(vendor.requests).toEqual([]);
    await signIn(destination.row);
    expect(await api.deps.store.find(TEST_OWNER, source.id)).toEqual(source);
  });

  test('a legacy imported private grant audience is discarded rather than promoted to public configuration', async () => {
    const original = configuration();
    delete original.oauthResource;
    original.tokens = { accessToken: 'source-access-fixture', refreshToken: 'source-refresh-fixture', resource: original.targetUrl, expiresAt: now - 1 };
    original.imported = { state: 'owned', tokenEndpointAuthMethod: 'client_secret_post', scope: 'read' };
    original.server = { ...original.server, authorizationEndpoint: '' };
    const source = await seed(original);
    const destination = await copy(source);
    expect(destination.secret).not.toHaveProperty('oauthResource');
    expect(vendor.requests).toEqual([]);
    await signIn(destination.row);
    expect(await api.deps.store.find(TEST_OWNER, source.id)).toEqual(source);
    expect(openConnectorSecret(KEY, source)).toEqual(original);
  });

  test('imported owned, refreshing, uncertain and signed-out grants become fresh sign-in setup with no old attempt', async () => {
    const states: ImportedGrant['state'][] = ['owned', 'refreshing', 'uncertain', 'signin'];
    for (const state of states) {
      const original = configuration();
      original.server = { ...original.server, authorizationEndpoint: '', supportsS256: false, scopes: [] };
      original.imported = { state, tokenEndpointAuthMethod: 'client_secret_post', scope: 'read', attempt: 'source-attempt-fixture' };
      const source = await seed(original);
      const destination = await copy(source);
      expect(destination.secret.imported).toEqual({ state: 'signin', tokenEndpointAuthMethod: 'client_secret_post', scope: 'read' });
      expect(destination.secret.client).toEqual(original.client);
      expect(destination.secret.targetUrl).toBe(original.targetUrl);
      expect(vendor.requests).toEqual([]);
      if (state === 'signin') {
        await signIn(destination.row);
        expect(await api.deps.store.find(TEST_OWNER, source.id)).toEqual(source);
      }
    }
    expect(vendor.registrations).toBe(0);
    expect(vendor.tokenCalls).toBe(1);
  });
});
