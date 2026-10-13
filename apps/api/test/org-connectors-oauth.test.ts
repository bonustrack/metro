import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { openSecret } from '../src/connectors/secrets.ts';
import { connectors } from '../src/db/schema.ts';
import { auth, bearer, TEST_OWNER, TEST_STRANGER } from './identity-helper.ts';
import { addAgent, PGLITE_START_MS, PGLITE_STEP_MS, testDb, type TestDb } from './pglite-db.ts';
import { ACCESS, CALLBACK, challengeOf, GOOD_KEY, REFRESH, RETURN_TO, startApi, startVendor, type Api, type Vendor } from './org-connectors-fixture.ts';

let held: TestDb;
let vendor: Vendor;
let api: Api;
let now = Date.parse('2026-10-11T06:00:00.000Z');

const post = async (path: string, body: unknown, authorization?: string): Promise<Response> => {
  now += 1;
  return fetch(`${api.base}${path}`, {
    method: 'POST',
    headers: { authorization: authorization ?? (await auth(TEST_OWNER)), 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
};

const back = (query: string): Promise<Response> => fetch(`${api.base}/api/connectors/callback?${query}`, { redirect: 'manual' });

interface Started {
  id: string;
  authorizeUrl: string;
}

async function startOAuth(name = 'Linear'): Promise<Started> {
  const res = await post('/api/connectors', { name, url: `${vendor.base}/oauth`, returnTo: RETURN_TO });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { connector: { id: string; auth: string; signIn: string }; authorizeUrl: string };
  expect(body.connector).toMatchObject({ auth: 'oauth', signIn: 'disconnected' });
  return { id: body.connector.id, authorizeUrl: body.authorizeUrl };
}

async function handoffFor(started: Started, code = 'code-1'): Promise<string> {
  const { state, challenge } = challengeOf(started.authorizeUrl);
  vendor.challenges.set(code, challenge);
  const res = await back(`state=${state}&code=${code}`);
  expect(res.status).toBe(302);
  const location = new URL(res.headers.get('location') ?? '');
  expect(`${location.origin}/`).toBe(RETURN_TO);
  expect(location.hash.split('?')[0]).toBe(`#/${TEST_OWNER}/organization/connectors/${started.id}`);
  expect(location.search).toBe('');
  return new URLSearchParams(location.hash.split('?')[1]).get('org_connector') ?? '';
}

beforeAll(async () => {
  held = await testDb();
  vendor = await startVendor();
  api = await startApi(() => held.db, () => now, vendor.fetch);
}, PGLITE_START_MS);

beforeEach(async () => {
  now += 60_000;
  await held.reset();
  await addAgent(held.db, 'agent000001', TEST_OWNER);
}, PGLITE_STEP_MS);

afterAll(async () => {
  await api.close();
  await vendor.close();
  await held.close();
});

describe('signing a connector in with OAuth on api.metro.box', () => {
  test('a server that asks for a sign-in is registered and the admin is sent to it with PKCE', async () => {
    const started = await startOAuth();
    const url = new URL(started.authorizeUrl);
    expect(`${url.origin}${url.pathname}`).toBe(`${vendor.base}/authorize`);
    expect(url.searchParams.get('redirect_uri')).toBe(CALLBACK);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(challengeOf(started.authorizeUrl)).toMatchObject({ clientId: `client-${String(vendor.registrations)}`, resource: `${vendor.base}/oauth` });
    const row = (await held.db.select().from(connectors).where(eq(connectors.id, started.id)))[0];
    expect(row?.auth).toBe('oauth');
    expect(row?.secret).not.toContain('client-1');
  });

  test('the callback hands the page a one-time handoff, and only the admin who started finishes it', async () => {
    const started = await startOAuth();
    const handoff = await handoffFor(started);
    expect(handoff).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await back(`state=${challengeOf(started.authorizeUrl).state}&code=code-1`)).status).toBe(400);
    const colleague = await bearer({ sub: 'user_01COLLEAGUE', org_id: TEST_OWNER, role: 'admin' });
    expect((await post('/api/connectors/complete', { handoff }, colleague)).status).toBe(403);
    expect((await post('/api/connectors/complete', { handoff }, await auth(TEST_STRANGER))).status).toBe(403);
    expect((await post('/api/connectors/complete', { handoff }, await auth(TEST_OWNER, 'member'))).status).toBe(403);
    const done = await post('/api/connectors/complete', { handoff });
    expect(done.status).toBe(200);
    const text = await done.text();
    expect(text).not.toContain(ACCESS);
    expect(JSON.parse(text)).toMatchObject({ id: started.id, signIn: 'connected', server: new URL(vendor.base).hostname });
    expect((await post('/api/connectors/complete', { handoff })).status).toBe(400);
    const row = (await held.db.select().from(connectors).where(eq(connectors.id, started.id)))[0];
    const key = api.deps.key();
    if (row?.secret === null || row === undefined || key === null) throw new Error('nothing was kept');
    expect(openSecret(key, TEST_OWNER, started.id, row.secret)).toMatchObject({ kind: 'oauth', client: { clientId: challengeOf(started.authorizeUrl).clientId }, tokens: { accessToken: ACCESS, refreshToken: REFRESH } });
  });

  test('a declined sign-in goes back to the page with the reason and stores no token', async () => {
    const started = await startOAuth();
    const res = await back(`state=${challengeOf(started.authorizeUrl).state}&error=access_denied`);
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get('location') ?? '');
    expect(new URLSearchParams(location.hash.split('?')[1]).get('org_connector_error')).toBe('The sign-in was declined, so nothing changed.');
    expect(new URLSearchParams(location.hash.split('?')[1]).get('org_connector')).toBeNull();
    const registered = vendor.registrations;
    const again = await post(`/api/connectors/${started.id}/sign-in`, { returnTo: RETURN_TO });
    expect(again.status).toBe(200);
    const url = ((await again.json()) as { authorizeUrl: string }).authorizeUrl;
    expect(challengeOf(url).clientId).toBe(challengeOf(started.authorizeUrl).clientId);
    expect(vendor.registrations).toBe(registered);
  });

  test('a stale state, a foreign return address or a key connector is refused', async () => {
    expect((await back('state=nope&code=x')).status).toBe(400);
    expect((await post('/api/connectors', { name: 'Linear', url: `${vendor.base}/oauth`, returnTo: 'https://evil.example/' })).status).toBe(400);
    expect((await post('/api/connectors', { name: 'Linear', url: `${vendor.base}/oauth`, returnTo: 'metro://auth' })).status).toBe(400);
    expect(await held.db.select().from(connectors)).toEqual([]);
    const keyed = await post('/api/connectors', { name: 'Keyed', url: `${vendor.base}/keyed`, value: GOOD_KEY });
    const id = ((await keyed.json()) as { connector: { id: string } }).connector.id;
    expect((await post(`/api/connectors/${id}/sign-in`, { returnTo: RETURN_TO })).status).toBe(400);
  });

  test('a code the server refuses leaves the connector signed out', async () => {
    const started = await startOAuth();
    const { state } = challengeOf(started.authorizeUrl);
    vendor.challenges.set('code-2', 'not-the-challenge');
    const res = await back(`state=${state}&code=code-2`);
    const handoff = new URLSearchParams(new URL(res.headers.get('location') ?? '').hash.split('?')[1]).get('org_connector') ?? '';
    const done = await post('/api/connectors/complete', { handoff });
    expect(done.status).toBe(400);
    expect(((await done.json()) as { error: string }).error).toBe('The provider could not complete sign-in or verify the MCP endpoint. Check its public OAuth resource and client registration, then sign in again.');
    const view = (await (await fetch(`${api.base}/api/connectors/${started.id}`, { headers: { authorization: await auth(TEST_OWNER) } })).json()) as { signIn: string };
    expect(view.signIn).toBe('disconnected');
  });
});


describe('only the current sign-in may complete', () => {
  test('deleting the connector or starting another sign-in refuses an old handoff before an exchange', async () => {
    for (const deleted of [false, true]) {
      const started = await startOAuth(deleted ? 'Delete it' : 'Replace it');
      const handoff = await handoffFor(started, 'pending-code');
      if (deleted) await fetch(`${api.base}/api/connectors/${started.id}`, { method: 'DELETE', headers: { authorization: await auth(TEST_OWNER) } });
      else await post(`/api/connectors/${started.id}/sign-in`, { returnTo: RETURN_TO });
      const before = vendor.tokenCalls;
      expect((await post('/api/connectors/complete', { handoff })).status).toBe(deleted ? 404 : 409);
      expect(vendor.tokenCalls).toBe(before);
    }
  });

  test('a stalled older exchange cannot overwrite a newer successful sign-in', async () => {
    const started = await startOAuth();
    const oldHandoff = await handoffFor(started, 'old-code');
    const original = api.deps.fetch;
    let release: () => void = () => undefined;
    let reached: () => void = () => undefined;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const exchanging = new Promise<void>((resolve) => { reached = resolve; });
    api.deps.fetch = async (url, init) => {
      if (!url.endsWith('/token')) return original(url, init);
      const form = new URLSearchParams(typeof init?.body === 'string' ? init.body : '');
      const older = form.get('code') === 'old-code';
      if (older) { reached(); await waiting; }
      const res = await original(url, init);
      const body = await res.json() as Record<string, unknown>;
      return Response.json({ ...body, refresh_token: older ? 'OLDER_REFRESH' : 'NEWER_REFRESH' }, { status: res.status });
    };
    try {
      const oldCompletion = post('/api/connectors/complete', { handoff: oldHandoff });
      await exchanging;
      const again = await post(`/api/connectors/${started.id}/sign-in`, { returnTo: RETURN_TO });
      const authorizeUrl = ((await again.json()) as { authorizeUrl: string }).authorizeUrl;
      const freshHandoff = await handoffFor({ id: started.id, authorizeUrl }, 'new-code');
      expect((await post('/api/connectors/complete', { handoff: freshHandoff })).status).toBe(200);
      release();
      expect((await oldCompletion).status).toBe(409);
      const row = (await held.db.select().from(connectors).where(eq(connectors.id, started.id)))[0];
      const key = api.deps.key();
      if (row === undefined || row.secret === null || key === null) throw new Error('nothing saved');
      expect(openSecret(key, TEST_OWNER, row.id, row.secret)).toMatchObject({ tokens: { refreshToken: 'NEWER_REFRESH' } });
    } finally {
      release();
      api.deps.fetch = original;
    }
  });
});
