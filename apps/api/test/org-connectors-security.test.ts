import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { openConnectorSecret, sealConnectorSecret, type ConnectorSecret } from '../src/connectors/model.js';
import { connectors } from '../src/db/schema.js';
import { auth, TEST_OWNER } from './identity-helper.js';
import { PGLITE_START_MS, testDb, type TestDb } from './pglite-db.js';
import { ACCESS, challengeOf, GOOD_KEY, REFRESH, RETURN_TO, startApi, startVendor, type Api, type Vendor } from './org-connectors-fixture.js';

const BASE = 'https://vendor.example.com';
const PRIVATE_PATH = '/oauth/private-tenant/%2fPRIVATE_ENDPOINT';
const TARGET = `${BASE}${PRIVATE_PATH}?api_key=PRIVATE_QUERY&sig=Sealed%2fSecret`;
const RESOURCE = `${BASE}/oauth`;
const PRM = '/.well-known/oauth-protected-resource';
const AS = '/.well-known/oauth-authorization-server';
const HIDDEN = ['PRIVATE_QUERY', 'PRIVATE_ENDPOINT', 'PRIVATE_USER', 'PRIVATE_PASSWORD', 'Sealed/Secret', ACCESS, REFRESH, GOOD_KEY];

let held: TestDb;
let vendor: Vendor;
let api: Api;

function redacted(value: string): void {
  for (const secret of HIDDEN) {
    expect(value).not.toContain(secret);
    expect(decodeURIComponent(value)).not.toContain(secret);
  }
}

async function post(path: string, body: unknown): Promise<Response> {
  return fetch(`${api.base}${path}`, { method: 'POST', headers: { authorization: await auth(TEST_OWNER), 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

const create = (extra: Record<string, unknown> = {}): Promise<Response> => post('/api/connectors', { name: 'Private tenant', url: TARGET, returnTo: RETURN_TO, ...extra });

async function started(): Promise<{ connector: { id: string }; authorizeUrl: string }> {
  const response = await create();
  expect(response.status).toBe(201);
  return await response.json() as { connector: { id: string }; authorizeUrl: string };
}

async function handoff(authorizeUrl: string): Promise<string> {
  const { state, challenge } = challengeOf(authorizeUrl);
  vendor.challenges.set('private-code', challenge);
  const response = await fetch(`${api.base}/api/connectors/callback?state=${state}&code=private-code`, { redirect: 'manual' });
  expect(response.status).toBe(302);
  redacted(response.headers.get('location') ?? '');
  return new URLSearchParams(new URL(response.headers.get('location') ?? '').hash.split('?')[1]).get('org_connector') ?? '';
}

async function changeSecret(id: string, edit: (secret: Extract<ConnectorSecret, { kind: 'oauth' }>) => ConnectorSecret): Promise<void> {
  const row = (await held.db.select().from(connectors).where(eq(connectors.id, id)))[0];
  const key = api.deps.key();
  if (row === undefined || key === null) throw new Error('Missing fixture connector');
  const secret = openConnectorSecret(key, row);
  if (secret?.kind !== 'oauth') throw new Error('Missing fixture OAuth secret');
  await held.db.update(connectors).set({ secret: sealConnectorSecret(key, row, edit(secret)) }).where(eq(connectors.id, id));
}

beforeAll(async () => {
  held = await testDb();
  vendor = await startVendor();
  vendor.oauthPaths.add(PRIVATE_PATH);
  api = await startApi(() => held.db, Date.now, vendor.fetch);
}, PGLITE_START_MS);
beforeEach(async () => {
  await held.reset();
  vendor.requests.length = 0;
  vendor.received.length = 0;
  vendor.keyedPaths.delete(PRIVATE_PATH);
  vendor.tokenForms.length = 0;
  vendor.replies.clear();
  vendor.resource = RESOURCE;
  vendor.serverTitle = TARGET;
  api.deps.fetch = vendor.fetch;
});
afterAll(async () => { await api?.close(); await vendor?.close(); await held?.close(); });

describe('public OAuth discovery never guesses a private transport resource', () => {
  test.each([
    ['another origin', 'https://other.example.com/oauth'],
    ['segment prefix rather than ancestor', `${BASE}/oau`],
    ['unrelated path', `${BASE}/other`],
    ['query credential', `${RESOURCE}?api_key=PRIVATE_QUERY`],
    ['userinfo', 'https://PRIVATE_USER:PRIVATE_PASSWORD@vendor.example.com/oauth'],
    ['fragment', `${RESOURCE}#PRIVATE_QUERY`],
    ['private host', 'https://10.0.0.1/oauth'],
    ['loopback host', 'https://localhost/oauth'],
    ['empty userinfo', 'https://@vendor.example.com/oauth'],
    ['empty query', `${RESOURCE}?`],
    ['invalid percent escape', `${RESOURCE}/%zz`],
    ['null resource', null],
  ])('rejects metadata with %s without issuer fallback or registration', async (_name, resource) => {
    vendor.replies.set(PRM, { status: 200, body: { resource, authorization_servers: [BASE] } });
    const response = await create();
    expect(response.status).toBe(400);
    redacted(await response.text());
    expect(vendor.requests.map((request) => request.url)).toEqual([TARGET, `${BASE}${PRM}`]);
    expect(await held.db.$count(connectors)).toBe(0);
  });

  test.each([false, true])('missing resource metadata requires an explicit public value, missing document=%s', async (missing) => {
    if (missing) vendor.replies.set(PRM, { status: 404, body: {} });
    else vendor.resource = null;
    const response = await create();
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining('public OAuth resource') });
    expect(vendor.requests.map((request) => request.url)).toEqual([TARGET, `${BASE}${PRM}`]);
    expect(await held.db.$count(connectors)).toBe(0);
    vendor.requests.length = 0;
    const explicit = await create({ oauthResource: RESOURCE });
    expect(explicit.status).toBe(201);
    const result = await explicit.json() as { authorizeUrl: string };
    expect(challengeOf(result.authorizeUrl).resource).toBe(RESOURCE);
    redacted(result.authorizeUrl);
    expect(vendor.requests[1]?.url).toBe(`${BASE}${PRM}/oauth`);
  });

  test('explicit resource cannot override an invalid or mismatched advertisement', async () => {
    vendor.replies.set(`${PRM}/oauth`, { status: 200, body: { resource: `${BASE}/`, authorization_servers: [BASE] } });
    const response = await create({ oauthResource: RESOURCE });
    expect(response.status).toBe(400);
    redacted(await response.text());
    expect(vendor.requests.map((request) => request.url)).toEqual([TARGET, `${BASE}${PRM}/oauth`]);
    expect(await held.db.$count(connectors)).toBe(0);
  });

  test.each([
    ['malformed document', 200, 'PRIVATE_QUERY'],
    ['redirect', 302, {}],
    ['provider failure', 500, { error_description: TARGET }],
    ['invalid issuer list', 200, { resource: RESOURCE, authorization_servers: [] }],
    ['confidential issuer', 200, { resource: RESOURCE, authorization_servers: [`${BASE}/issuer?key=PRIVATE_QUERY`] }],
  ])('%s fails closed instead of silently using fallback metadata', async (_name, status, body) => {
    vendor.replies.set(PRM, { status: Number(status), body, headers: { location: 'https://10.0.0.1/PRIVATE_QUERY' } });
    const response = await create();
    expect(response.status).toBe(400);
    redacted(await response.text());
    expect(vendor.requests.map((request) => request.url)).toEqual([TARGET, `${BASE}${PRM}`]);
    expect(await held.db.$count(connectors)).toBe(0);
  });

  test.each([
    { issuer: 'https://other.example.com' },
    { authorization_endpoint: 'https://PRIVATE_USER:PRIVATE_PASSWORD@vendor.example.com/authorize' },
    { token_endpoint: 'https://127.0.0.1/PRIVATE_ENDPOINT' },
    { registration_endpoint: 'http://vendor.example.com/register' },
  ])('invalid authorization metadata refuses the whole advertised configuration %j', async (patch) => {
    vendor.replies.set(AS, { status: 200, body: { issuer: BASE, authorization_endpoint: `${BASE}/authorize`, token_endpoint: `${BASE}/token`, registration_endpoint: `${BASE}/register`, code_challenge_methods_supported: ['S256'], ...patch } });
    const response = await create();
    expect(response.status).toBe(400);
    redacted(await response.text());
    expect(vendor.requests.map((request) => request.url)).toEqual([TARGET, `${BASE}${PRM}`, `${BASE}${AS}`]);
    expect(await held.db.$count(connectors)).toBe(0);
  });
});

describe('private inputs and provider errors never return to the page', () => {
  test('static header rotation hides reflected secret paths, queries and legacy server titles', async () => {
    vendor.keyedPaths.add(PRIVATE_PATH);
    const added = await create({ value: GOOD_KEY });
    expect(added.status).toBe(201);
    const createdText = await added.text();
    redacted(createdText);
    const id = (JSON.parse(createdText) as { connector: { id: string } }).connector.id;
    await held.db.update(connectors).set({ detail: JSON.stringify({ server: TARGET, header: 'Authorization' }) }).where(eq(connectors.id, id));
    const member = await auth(TEST_OWNER, 'member');
    for (const route of ['/api/connectors', `/api/connectors/${id}`]) {
      const response = await fetch(`${api.base}${route}`, { headers: { authorization: member } });
      expect(response.status).toBe(200);
      redacted(await response.text());
    }
    const rotate = async (): Promise<Response> => fetch(`${api.base}/api/connectors/${id}`, { method: 'PUT', headers: { authorization: await auth(TEST_OWNER), 'content-type': 'application/json' }, body: JSON.stringify({ value: GOOD_KEY }) });
    const rotated = await rotate();
    expect(rotated.status).toBe(200);
    const rotatedText = await rotated.text();
    redacted(rotatedText);
    expect(JSON.parse(rotatedText)).toMatchObject({ server: new URL(BASE).hostname, auth: 'header' });
    expect(vendor.received).toEqual(Array.from({ length: 2 }, () => ({ path: TARGET.slice(BASE.length), method: 'POST', authorization: GOOD_KEY })));
    const row = (await held.db.select().from(connectors).where(eq(connectors.id, id)))[0];
    if (row === undefined) throw new Error('missing rotated connector');
    redacted(row.detail ?? '');
    vendor.replies.set(PRIVATE_PATH, { status: 200, body: { jsonrpc: '2.0', id: 1, error: { code: -32603, message: `${TARGET} PRIVATE_USER PRIVATE_PASSWORD` } } });
    const failed = await rotate();
    expect(failed.status).toBe(400);
    const failure = await failed.text();
    redacted(failure);
    expect(JSON.parse(failure)).toEqual({ error: 'The provider could not verify the HTTP MCP endpoint with that key.' });
    expect((await held.db.select().from(connectors).where(eq(connectors.id, id)))[0]).toEqual(row);
  });

  test.each([
    'https://PRIVATE_USER:PRIVATE_PASSWORD@vendor.example.com/private?key=PRIVATE_QUERY',
    'https://10.0.0.1/PRIVATE_ENDPOINT?key=PRIVATE_QUERY',
    `${TARGET}#PRIVATE_QUERY`,
  ])('invalid transport %s is refused before any provider request', async (url) => {
    const response = await create({ url });
    expect(response.status).toBe(400);
    redacted(await response.text());
    expect(vendor.requests).toHaveLength(0);
    expect(await held.db.$count(connectors)).toBe(0);
  });

  test.each(['access_denied', 'invalid_request', `invalid_${TARGET}`])('callback %s ignores provider error descriptions and URIs', async (error) => {
    const created = await started();
    const query = new URLSearchParams({ state: challengeOf(created.authorizeUrl).state, error, error_description: `${TARGET} PRIVATE_USER PRIVATE_PASSWORD`, error_uri: TARGET });
    const count = vendor.tokenCalls;
    const response = await fetch(`${api.base}/api/connectors/callback?${query.toString()}`, { redirect: 'manual' });
    expect(response.status).toBe(302);
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    const location = response.headers.get('location') ?? '';
    redacted(location);
    expect(new URL(location).search).toBe('');
    expect(new URLSearchParams(new URL(location).hash.split('?')[1]).has('org_connector_error')).toBe(true);
    expect(vendor.tokenCalls).toBe(count);
  });

  test.each(['/token', PRIVATE_PATH])('redirects during %s are not followed or reflected', async (path) => {
    const created = await started();
    const ticket = await handoff(created.authorizeUrl);
    vendor.replies.set(path, { status: 302, body: { error_description: TARGET }, headers: { location: `https://PRIVATE_USER:PRIVATE_PASSWORD@10.0.0.1/${PRIVATE_PATH}?key=PRIVATE_QUERY` } });
    const response = await post('/api/connectors/complete', { handoff: ticket });
    expect(response.status).toBe(400);
    redacted(await response.text());
    expect(vendor.requests.every((request) => new URL(request.url).origin === BASE)).toBe(true);
    const shown = await fetch(`${api.base}/api/connectors/${created.connector.id}`, { headers: { authorization: await auth(TEST_OWNER) } });
    const text = await shown.text();
    expect(JSON.parse(text)).toMatchObject({ signIn: 'disconnected' });
    redacted(text);
  });
});

describe('a pending sign-in is bound to its prepared configuration', () => {
  test.each(['transport', 'client', 'server', 'audience', 'audience removal'])('%s changed before code exchange refuses the handoff without issuing tokens', async (field) => {
    const created = await started();
    const ticket = await handoff(created.authorizeUrl);
    await changeSecret(created.connector.id, (secret) => ({
      ...secret,
      ...(field === 'transport' ? { targetUrl: `${BASE}/oauth/other-private?key=PRIVATE_QUERY` } : {}),
      ...(field === 'client' ? { client: { ...secret.client, clientSecret: 'PRIVATE_PASSWORD' } } : {}),
      ...(field === 'server' ? { server: { ...secret.server, tokenEndpoint: `${BASE}/other-token` } } : {}),
      ...(field === 'audience' ? { oauthResource: `${BASE}/` } : {}),
      ...(field === 'audience removal' ? { oauthResource: undefined } : {}),
    }));
    const count = vendor.tokenCalls;
    const response = await post('/api/connectors/complete', { handoff: ticket });
    expect(response.status).toBe(409);
    redacted(await response.text());
    expect(vendor.tokenCalls).toBe(count);
    expect((await post('/api/connectors/complete', { handoff: ticket })).status).toBe(400);
  });

  test('configuration changed during code exchange cannot be overwritten by completed tokens', async () => {
    const created = await started();
    const ticket = await handoff(created.authorizeUrl);
    api.deps.fetch = async (url, init) => {
      const response = await vendor.fetch(url, init);
      if (url === `${BASE}/token`) await changeSecret(created.connector.id, (secret) => ({ ...secret, client: { clientId: 'replacement-client' } }));
      return response;
    };
    const response = await post('/api/connectors/complete', { handoff: ticket });
    expect(response.status).toBe(409);
    redacted(await response.text());
    const row = (await held.db.select().from(connectors).where(eq(connectors.id, created.connector.id)))[0];
    const key = api.deps.key();
    if (row === undefined || key === null) throw new Error('Missing fixture row');
    const secret = openConnectorSecret(key, row);
    expect(secret).toMatchObject({ client: { clientId: 'replacement-client' } });
    expect(secret?.kind === 'oauth' ? secret.tokens : null).toBeUndefined();
  });

  test('changing a held public audience is refused before replacing a valid pending sign-in', async () => {
    const created = await started();
    const before = (await held.db.select().from(connectors))[0]?.authGeneration;
    const response = await post(`/api/connectors/${created.connector.id}/sign-in`, { returnTo: RETURN_TO, oauthResource: `${BASE}/` });
    expect(response.status).toBe(409);
    expect((await held.db.select().from(connectors))[0]?.authGeneration).toBe(before);
    const ticket = await handoff(created.authorizeUrl);
    expect((await post('/api/connectors/complete', { handoff: ticket })).status).toBe(200);
  });
});
