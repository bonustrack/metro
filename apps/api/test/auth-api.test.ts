import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SigningKeys } from '@metro-labs/http/workos-token';
import { handleAuthApiRequest, type AuthApiDeps } from '../src/auth/routes.ts';
import { forgetProviders, readWorkosConfig } from '../src/auth/workos.ts';
import { fakeWorkos, type FakeWorkos } from './workos-fake.ts';
import { memorySlugs } from './slug-fake.ts';
import { memoryUsers } from './users-fake.ts';
import { pngDataUrl } from './png-fixture.ts';
import { sessionClaims } from '../../../packages/http/test/workos-fixture.ts';

let workos: FakeWorkos;
let server: Server;
let base = '';
let deps: AuthApiDeps;

beforeAll(async () => {
  workos = await fakeWorkos();
  const env = { WORKOS_API_KEY: 'sk_test_fake', WORKOS_CLIENT_ID: 'client_test', WORKOS_API_BASE: workos.base };
  deps = { config: () => readWorkosConfig(env), keys: new SigningKeys(workos.issuer.url), publicBase: () => base, slugs: memorySlugs(), users: memoryUsers() };
  server = createServer((req, res) => {
    if (handleAuthApiRequest(req, res, deps)) return;
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => {
    server.listen(0, '127.0.0.1', r);
  });
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

afterAll(async () => {
  server.close();
  await workos.close();
});

const json = (method: string, path: string, body?: unknown, bearer?: string): Promise<Response> =>
  fetch(`${base}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(bearer === undefined ? {} : { authorization: `Bearer ${bearer}` }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

interface TokenBody {
  accessToken: string;
  refreshToken: string;
  organization: string | null;
  user: { id: string; email: string; name: string; picture: string };
}

async function handoffFromGoogle(): Promise<string> {
  const start = await fetch(`${base}/api/auth/login?provider=google&return_to=${encodeURIComponent('https://metro.box/')}`, { redirect: 'manual' });
  expect(start.status).toBe(302);
  const toGoogle = new URL(start.headers.get('location') ?? '');
  expect(toGoogle.searchParams.get('provider')).toBe('GoogleOAuth');
  expect(toGoogle.searchParams.get('client_id')).toBe('client_test');
  const fromGoogle = await fetch(toGoogle, { redirect: 'manual' });
  const back = await fetch(fromGoogle.headers.get('location') ?? '', { redirect: 'manual' });
  expect(back.status).toBe(302);
  const landed = new URL(back.headers.get('location') ?? '');
  expect(landed.origin).toBe('https://metro.box');
  const handoff = /^#\/auth\/(.+)$/.exec(landed.hash)?.[1];
  if (handoff === undefined) throw new Error(`no handoff in ${landed.hash}`);
  return handoff;
}

async function signIn(): Promise<TokenBody> {
  const handoff = await handoffFromGoogle();
  const exchanged = await json('POST', '/api/auth/exchange', { code: handoff });
  expect(exchanged.status).toBe(200);
  return (await exchanged.json()) as TokenBody;
}

describe('signing in to metro.box through WorkOS', () => {
  test('the account name goes to WorkOS and the picture to metro.box, and both come back on the next tokens', async () => {
    const tokens = await signIn();
    expect((await json('PUT', '/api/auth/account', { name: '  Fabien   Less ' }, tokens.accessToken)).status).toBe(200);
    expect((await json('PUT', '/api/auth/account', { avatar: pngDataUrl(64, 64) }, tokens.accessToken)).status).toBe(200);
    expect((await json('PUT', '/api/auth/account', { avatar: 'data:image/svg+xml;base64,PHN2Zz4=' }, tokens.accessToken)).status).toBe(400);
    expect((await json('PUT', '/api/auth/account', {}, tokens.accessToken)).status).toBe(400);
    expect((await json('PUT', '/api/auth/account', { name: 'x' })).status).toBe(401);
    const refreshed = (await (await json('POST', '/api/auth/refresh', { refreshToken: tokens.refreshToken })).json()) as TokenBody;
    expect(refreshed.user.name).toBe('Fabien Less');
    expect(refreshed.user.picture.startsWith('data:image/png;base64,')).toBe(true);
    expect((await json('PUT', '/api/auth/account', { avatar: null, name: 'Stage Labs' }, tokens.accessToken)).status).toBe(200);
    const back = (await (await json('POST', '/api/auth/refresh', { refreshToken: refreshed.refreshToken })).json()) as TokenBody;
    expect(back.user).toMatchObject({ name: 'Stage Labs', picture: 'https://pic.example/a.png' });
  });

  test('a user in several organizations is signed in to the first one WorkOS lists instead of being asked to choose', async () => {
    const before = workos.organizations.length;
    workos.organizations.push('org_01FIRST0000000', 'org_01SECOND000000');
    workos.selection.on = true;
    try {
      const handoff = await handoffFromGoogle();
      const exchanged = await json('POST', '/api/auth/exchange', { code: handoff });
      expect(exchanged.status).toBe(200);
      expect(((await exchanged.json()) as TokenBody).organization).toBe(workos.organizations[0] ?? '');
    } finally {
      workos.selection.on = false;
      workos.organizations.splice(before);
      deps.slugs = memorySlugs();
    }
  });

  test('the status says whether sign-in is configured and which providers WorkOS answers for; a provider not set up is refused by name', async () => {
    forgetProviders();
    expect(await (await json('GET', '/api/auth')).json()).toEqual({ enabled: true, providers: ['google'] });
    const microsoft = await fetch(`${base}/api/auth/login?provider=microsoft&return_to=https://metro.box/`, { redirect: 'manual' });
    expect(microsoft.status).toBe(302);
    expect(microsoft.headers.get('location')).toBe(`https://metro.box/#/login?error=${encodeURIComponent('microsoft sign-in is not set up on WorkOS yet')}`);
    workos.enabled.add('MicrosoftOAuth');
    workos.enabled.add('GitHubOAuth');
    forgetProviders();
    expect(await (await json('GET', '/api/auth')).json()).toEqual({ enabled: true, providers: ['google', 'microsoft', 'github'] });
    workos.enabled.delete('MicrosoftOAuth');
    workos.enabled.delete('GitHubOAuth');
    forgetProviders();
    expect(await (await json('GET', '/api/auth')).json()).toEqual({ enabled: true, providers: ['google'] });
    workos.outage.on = true;
    try {
      deps.now = () => Date.now() + 2 * 60_000;
      expect(await (await json('GET', '/api/auth')).json()).toEqual({ enabled: true, providers: ['google'] });
      await new Promise((r) => setTimeout(r, 50));
      expect(await (await json('GET', '/api/auth')).json()).toEqual({ enabled: true, providers: ['google'] });
    } finally {
      workos.outage.on = false;
      deps.now = undefined;
    }
    forgetProviders();
    const off = { ...deps, config: () => null };
    const s = createServer((req, res) => {
      handleAuthApiRequest(req, res, off);
    });
    await new Promise<void>((r) => {
      s.listen(0, '127.0.0.1', r);
    });
    const port = String((s.address() as AddressInfo).port);
    expect(await (await fetch(`http://127.0.0.1:${port}/api/auth`)).json()).toEqual({ enabled: false, providers: [] });
    expect((await fetch(`http://127.0.0.1:${port}/api/auth/login?provider=google&return_to=https://metro.box/`, { redirect: 'manual' })).status).toBe(503);
    s.close();
  });

  test('login goes to the provider, the callback hands off a one-time code, and the exchange returns tokens once', async () => {
    const tokens = await signIn();
    expect(tokens.user).toEqual({ id: 'user_01ABC', email: 'admin@stage.box', name: 'Stage Labs', picture: 'https://pic.example/a.png' });
    expect(tokens.organization).toBeNull();
    expect(tokens.accessToken.split('.')).toHaveLength(3);
    const me = await json('GET', '/api/auth/me', undefined, tokens.accessToken);
    expect(await me.json()).toMatchObject({ userId: 'user_01ABC', organization: null, role: null });
    expect((await json('POST', '/api/auth/exchange', { code: 'nope' })).status).toBe(404);
  });

  test('a bad provider, a foreign return_to, a stale state and a cancelled sign-in are all handled', async () => {
    expect((await fetch(`${base}/api/auth/login?provider=facebook&return_to=https://metro.box/`, { redirect: 'manual' })).status).toBe(400);
    expect((await fetch(`${base}/api/auth/login?provider=google&return_to=https://evil.example/`, { redirect: 'manual' })).status).toBe(400);
    expect((await fetch(`${base}/api/auth/callback?code=x&state=unknown`, { redirect: 'manual' })).status).toBe(400);
    const start = await fetch(`${base}/api/auth/login?provider=google&return_to=https://metro.box/`, { redirect: 'manual' });
    const state = new URL(start.headers.get('location') ?? '').searchParams.get('state') ?? '';
    const cancelled = await fetch(`${base}/api/auth/callback?error=access_denied&error_description=User+said+no&state=${state}`, { redirect: 'manual' });
    expect(cancelled.status).toBe(302);
    expect(cancelled.headers.get('location')).toBe('https://metro.box/#/login?error=User%20said%20no');
  });

  test('creating the organization makes the user its admin and returns tokens that carry it; a second one can be created and switched to', async () => {
    const tokens = await signIn();
    const made = await json('POST', '/api/auth/organization', { name: ' Stage Labs ', refreshToken: tokens.refreshToken }, tokens.accessToken);
    expect(made.status).toBe(200);
    const withOrg = (await made.json()) as TokenBody;
    expect(withOrg.organization).toBe(workos.organizations[0] ?? '');
    expect((withOrg as unknown as { organizationName: string }).organizationName).toBe('Stage Labs');
    const membership = workos.calls.find((c) => c.path === '/user_management/organization_memberships');
    expect(membership?.body).toEqual({ user_id: 'user_01ABC', organization_id: workos.organizations[0], role_slug: 'admin' });
    expect(membership?.auth).toBe('Bearer sk_test_fake');
    expect(workos.calls.find((c) => c.path === '/organizations')?.body).toEqual({ name: 'Stage Labs' });
    const me = (await (await json('GET', '/api/auth/me', undefined, withOrg.accessToken)).json()) as { organization: string; role: string };
    expect(me).toMatchObject({ organization: workos.organizations[0], role: 'admin' });
    const second = await json('POST', '/api/auth/organization', { name: 'Twice', refreshToken: withOrg.refreshToken }, withOrg.accessToken);
    expect(second.status).toBe(200);
    const inSecond = (await second.json()) as TokenBody;
    expect(inSecond.organization).toBe(workos.organizations[1] ?? '');
    const listed = await json('GET', '/api/auth/organizations', undefined, inSecond.accessToken);
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({ organizations: [{ id: workos.organizations[0], name: 'Stage Labs', role: 'admin', slug: 'stage-labs' }, { id: workos.organizations[1], name: 'Twice', role: 'admin', slug: 'twice' }] });
    expect((inSecond as unknown as { organizationSlug: string }).organizationSlug).toBe('twice');
    const back = await json('POST', '/api/auth/switch', { organization: workos.organizations[0], refreshToken: inSecond.refreshToken }, inSecond.accessToken);
    expect(back.status).toBe(200);
    expect(((await back.json()) as TokenBody).organization).toBe(workos.organizations[0] ?? '');
    expect((await json('POST', '/api/auth/switch', { organization: 'org_01NOTMINE', refreshToken: inSecond.refreshToken }, inSecond.accessToken)).status).toBe(404);
    expect((await json('POST', '/api/auth/organization', { name: 'x', refreshToken: tokens.refreshToken }, tokens.accessToken)).status).toBe(400);
  });

  test('refresh rotates the pair, a revoked refresh token is 401, and logout revokes the session', async () => {
    const tokens = await signIn();
    const fresh = await json('POST', '/api/auth/refresh', { refreshToken: tokens.refreshToken });
    expect(fresh.status).toBe(200);
    const next = (await fresh.json()) as TokenBody;
    expect(next.refreshToken).not.toBe(tokens.refreshToken);
    expect((await json('POST', '/api/auth/refresh', { refreshToken: 'rt_dead' })).status).toBe(401);
    expect((await json('POST', '/api/auth/refresh', {})).status).toBe(400);
    const out = await json('POST', '/api/auth/logout', undefined, next.accessToken);
    expect(out.status).toBe(200);
    expect(workos.calls.at(-1)).toMatchObject({ path: '/user_management/sessions/revoke', body: { session_id: 'session_01XYZ' } });
  });

  test('a signed-in route refuses no token, a forged token and a token from another issuer', async () => {
    expect((await json('GET', '/api/auth/me')).status).toBe(401);
    expect((await json('GET', '/api/auth/me', undefined, 'a.b.c')).status).toBe(401);
    const foreign = workos.issuer.mint(sessionClaims({ iss: 'https://other.example' }));
    expect((await json('GET', '/api/auth/me', undefined, foreign)).status).toBe(401);
    expect((await json('DELETE', '/api/auth/me', undefined, workos.issuer.mint(sessionClaims()))).status).toBe(405);
    expect((await json('GET', '/api/auth/nothing')).status).toBe(404);
    expect((await fetch(`${base}/api/auth/me`, { method: 'OPTIONS' })).status).toBe(204);
  });
});
