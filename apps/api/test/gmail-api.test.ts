import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { randomInt } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { handleGmailApiRequest, type GmailApiDeps } from '../src/gmail/api.js';
import { readGmailConfig } from '../src/gmail/config.js';
import { gmailUserAllowed } from '../src/gmail/authorization.js';
import { bearer, testKeys } from './identity-helper.js';
import { memoryUsers } from './users-fake.js';
import { AGENT, HOST, PKCE, SESSION, START, credential, gmailFixture } from './gmail-fake.js';

const GMAIL_ENV = { METRO_GMAIL_CLIENT_ID: 'test-client', METRO_GMAIL_CLIENT_SECRET: 'test-secret', METRO_GMAIL_GRANT_KEY: 'aB'.repeat(32) };

let f = gmailFixture();
let deps: GmailApiDeps;
let server: Server;
let base = '';
let authorization = '';

beforeAll(async () => {
  deps = { keys: await testKeys(), broker: f.broker };
  authorization = await bearer({ org_id: SESSION.organization });
  server = createServer((req, res) => {
    if (!handleGmailApiRequest(req, res, deps)) res.writeHead(404).end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(randomInt(10_000, 29_999), '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

afterAll(() => server.close());
beforeEach(() => {
  f = gmailFixture();
  deps.broker = f.broker;
});

const call = (action = '', body?: unknown, token: string | null = authorization, method = action === '' ? 'GET' : 'POST') => fetch(`${base}/api/gmail${action === '' ? '' : `/${action}`}`, {
  method,
  headers: { ...(token === null ? {} : { authorization: token }), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

describe('managed Gmail API wire', () => {
  test('availability requires a valid WorkOS bearer and only returns configuration availability', async () => {
    expect((await call('', undefined, null)).status).toBe(401);
    expect((await call('', undefined, 'Bearer invalid')).status).toBe(401);
    expect((await call('', undefined, await bearer({ exp: 1 }))).status).toBe(401);
    const available = await call();
    expect(available.status).toBe(200);
    expect(available.headers.get('cache-control')).toBe('no-store');
    expect(await available.json()).toEqual({ available: true });
    f.state.config = null;
    expect(await (await call()).json()).toEqual({ available: false });
    expect((await call('start', START)).status).toBe(503);
    expect(f.state.requests).toHaveLength(0);
  });

  test('deployed credentials cannot activate managed routes without explicit opt-in', async () => {
    for (const enabled of [undefined, '', 'false', '1', 'TRUE', ' true', 'true ']) {
      f.state.config = readGmailConfig({ ...GMAIL_ENV, METRO_GMAIL_ENABLED: enabled });
      expect(await (await call()).json()).toEqual({ available: false });
      for (const action of ['start', 'exchange', 'refresh', 'revoke']) {
        const response = await call(action, action === 'start' ? START : {});
        expect(response.status).toBe(503);
        expect(await response.json()).toEqual({ error: 'Managed Gmail sign-in is not configured.' });
      }
      expect(f.state.requests).toHaveLength(0);
      expect(f.state.allowedChecks).toHaveLength(0);
      expect(f.states.size()).toBe(0);
    }
    f.state.config = readGmailConfig({ ...GMAIL_ENV, METRO_GMAIL_ENABLED: 'true' });
    expect(await (await call()).json()).toEqual({ available: true });
    expect((await call('start', START)).status).toBe(200);
  });

  test('start, exchange and cancel need a valid bearer in an organization', async () => {
    for (const action of ['start', 'exchange', 'cancel']) {
      expect((await call(action, {}, null)).status).toBe(401);
      expect((await call(action, {}, await bearer({ org_id: undefined }))).status).toBe(401);
    }
    expect((await call('', undefined, await bearer({ org_id: undefined }))).status).toBe(200);
    expect(f.state.requests).toHaveLength(0);
  });

  test('methods are enforced for every route, with no-store errors and preflights', async () => {
    const wrongIndex = await call('', {}, authorization, 'POST');
    expect(wrongIndex.status).toBe(405);
    expect(wrongIndex.headers.get('allow')).toBe('GET, OPTIONS');
    for (const action of ['start', 'exchange', 'cancel', 'refresh', 'revoke']) {
      const wrong = await call(action, undefined, null, 'GET');
      expect(wrong.status).toBe(405);
      expect(wrong.headers.get('cache-control')).toBe('no-store');
      expect(wrong.headers.get('allow')).toBe('POST, OPTIONS');
      expect((await call(action, undefined, null, 'OPTIONS')).status).toBe(204);
    }
    expect((await call('unknown')).status).toBe(404);
    expect((await fetch(`${base}/api/gmail-other`)).status).toBe(404);
    expect(f.state.requests).toHaveLength(0);
  });

  test('the fixed wire supports start, exchange, headless refresh and headless revoke', async () => {
    const started = await call('start', START);
    expect(started.status).toBe(200);
    const { state } = await started.json() as { state: string };
    const exchanged = await call('exchange', { state, code: 'fake-code', verifier: PKCE.verifier, host: HOST, agentId: AGENT });
    expect(exchanged.status).toBe(200);
    expect(exchanged.headers.get('cache-control')).toBe('no-store');
    const tokens = await exchanged.json() as { refreshToken: string; refreshGrant: string };
    const refreshed = await call('refresh', credential(tokens), null);
    expect(refreshed.status).toBe(200);
    expect(await refreshed.json()).toMatchObject({ managed: true, managedHost: HOST, sendEnabled: false });
    const revoked = await call('revoke', credential(tokens), null);
    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toEqual({ revoked: true });
  });

  test('an expired grant can revoke an already-removed Google token but cannot refresh', async () => {
    const connected = await f.connected();
    f.state.now += 91 * 86_400_000;
    f.state.revokeStatus = 400;
    f.state.revokeBody = JSON.stringify({ error: 'invalid_token' });
    const expiredRefresh = await call('refresh', credential(connected), null);
    expect(expiredRefresh.status).toBe(401);
    const revoked = await call('revoke', credential(connected), null);
    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toEqual({ revoked: true });
  });

  test('a renewed WorkOS token with the same sid is accepted, a different sid is not', async () => {
    const { state } = await f.start();
    const body = { state, code: 'fake-code', verifier: PKCE.verifier, host: HOST, agentId: AGENT };
    const same = await bearer({ org_id: SESSION.organization, exp: Math.floor(Date.now() / 1000) + 600 });
    expect((await call('exchange', body, same)).status).toBe(200);
    body.state = (await f.start()).state;
    const other = await bearer({ org_id: SESSION.organization, sid: 'different-session' });
    expect((await call('exchange', body, other)).status).toBe(400);
  });

  test('cancellation returns its fixed receipt and unknown state is stale', async () => {
    const { state } = await f.start();
    expect(await (await call('cancel', { state, host: HOST, agentId: AGENT })).json()).toEqual({ cancelled: true });
    const again = await call('cancel', { state, host: HOST, agentId: AGENT });
    expect(again.status).toBe(400);
    expect(await again.text()).toContain('stale');
    expect(f.state.requests).toHaveLength(0);
  });

  test('provider and internal errors never echo secrets, request data, or error descriptions', async () => {
    const secret = 'private-provider-token-do-not-echo';
    f.state.tokenStatus = 400;
    f.state.token = { error: 'access_denied', error_description: secret };
    const { state } = await f.start();
    const error = await call('exchange', { state, code: secret, verifier: PKCE.verifier, host: HOST, agentId: AGENT });
    expect(error.status).toBe(400);
    expect(await error.json()).toEqual({ error: 'Google refused this Gmail sign-in. Connect Gmail again.' });
    f.state.allowedFailure = new Error(secret);
    const internal = await call('start', START);
    expect(internal.status).toBe(503);
    expect(await internal.json()).toEqual({ error: 'Managed Gmail sign-in is unavailable. Try again.' });
  });

  test('provider service failures reach HTTP as 503 without changing OAuth or grant refusals', async () => {
    const connected = await f.connected();
    f.state.failure = new Error('private-provider-details');
    const unavailable = await call('refresh', credential(connected), null);
    expect(unavailable.status).toBe(503);
    expect(unavailable.headers.get('cache-control')).toBe('no-store');
    expect(await unavailable.json()).toEqual({ error: 'Google could not be reached for Gmail sign-in. Try again.' });
    f.state.failure = null;
    for (const status of [400, 401]) {
      f.state.tokenStatus = status;
      expect((await call('refresh', credential(connected), null)).status).toBe(400);
    }
    const invalid = await call('refresh', { ...credential(connected), refreshGrant: 'invalid' }, null);
    expect(invalid.status).toBe(401);
  });

  test('malformed and oversized bodies are rejected without provider traffic or unsafe echoes', async () => {
    for (const body of ['{secret malformed', JSON.stringify({ value: 'secret'.repeat(5000) })]) {
      const response = await fetch(`${base}/api/gmail/start`, { method: 'POST', headers: { authorization, 'content-type': 'application/json' }, body });
      expect([400, 413]).toContain(response.status);
      expect(await response.text()).not.toContain('secret');
    }
    expect(f.state.requests).toHaveLength(0);
  });
});

describe('managed Gmail browser credential boundary', () => {
  test('authenticated availability remains readable by a browser with CORS', async () => {
    const response = await fetch(`${base}/api/gmail`, {
      headers: { authorization, origin: 'https://metro.box', 'sec-fetch-mode': 'cors', 'sec-fetch-site': 'same-site' },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBe('https://metro.box');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ available: true });
    expect(f.state.allowedChecks).toHaveLength(0);
    expect(f.state.requests).toHaveLength(0);
  });

  for (const action of ['start', 'exchange', 'refresh', 'revoke', 'cancel'] as const) {
    test(`${action} refuses every browser header before auth, body, broker or provider work`, async () => {
      const tokens = await f.connected();
      const { state } = await f.start();
      const bodies = {
        start: START,
        exchange: { state, code: 'fake-code', verifier: PKCE.verifier, host: HOST, agentId: AGENT },
        cancel: { state, host: HOST, agentId: AGENT },
        refresh: credential(tokens),
        revoke: credential(tokens),
      };
      const providerCalls = f.state.requests.length;
      const allowedChecks = f.state.allowedChecks.length;
      const methods = ['start', 'exchange', 'refresh', 'revoke', 'cancel'] as const;
      const spies = methods.map((name) => spyOn(f.broker, name));
      try {
        for (const [header, value] of [
          ['Origin', 'https://metro.box'], ['Origin', 'null'], ['Origin', ''],
          ['Sec-Fetch-Site', 'none'], ['Sec-Fetch-Mode', 'cors'], ['Sec-Fetch-Dest', 'empty'],
          ['Sec-Fetch-User', '?1'], ['Sec-Fetch-Future', ''],
        ]) {
          const response = await fetch(`${base}/api/gmail/${action}`, {
            method: 'POST', headers: { authorization, 'content-type': 'application/json', [header!]: value! },
            body: JSON.stringify(bodies[action]),
          });
          expect(response.status).toBe(403);
          expect(response.headers.get('cache-control')).toBe('no-store');
          expect(await response.json()).toEqual({ error: 'Connect Gmail through your Metro server, not directly from a browser.' });
        }
        const malformed = await fetch(`${base}/api/gmail/${action}`, {
          method: 'POST', headers: { origin: 'https://metro.box' }, body: '{malformed',
        });
        expect(malformed.status).toBe(403);
        expect(await malformed.text()).toContain('not directly from a browser');
        for (const spy of spies) expect(spy).not.toHaveBeenCalled();
        expect(f.state.requests).toHaveLength(providerCalls);
        expect(f.state.allowedChecks).toHaveLength(allowedChecks);
        expect(f.states.size(f.state.now)).toBe(1);
        expect(f.states.peek(state, f.state.now)).toHaveProperty('userId', SESSION.userId);
      } finally {
        for (const spy of spies) spy.mockRestore();
      }
      const token = action === 'refresh' || action === 'revoke' ? null : authorization;
      expect((await call(action, bodies[action], token)).status).toBe(200);
    });
  }
});

describe('managed Gmail environment and durable user checks', () => {
  test('configuration requires explicit opt-in, every Gmail value and a strict 32-byte hex signing key', () => {
    const env = { ...GMAIL_ENV, METRO_GMAIL_ENABLED: 'true' };
    expect(readGmailConfig(GMAIL_ENV)).toBeNull();
    expect(readGmailConfig(env)).toEqual({ clientId: 'test-client', clientSecret: 'test-secret', grantKey: Buffer.from(env.METRO_GMAIL_GRANT_KEY, 'hex') });
    expect(readGmailConfig({})).toBeNull();
    for (const field of Object.keys(env)) expect(readGmailConfig({ ...env, [field]: '' })).toBeNull();
    for (const key of ['x'.repeat(64), 'ab'.repeat(31), 'ab'.repeat(33), `${env.METRO_GMAIL_GRANT_KEY}\n`, Buffer.alloc(32).toString('base64')])
      expect(readGmailConfig({ ...env, METRO_GMAIL_GRANT_KEY: key })).toBeNull();
  });

  test('a current active membership is mandatory, even for approved users and the operator', async () => {
    const users = memoryUsers();
    const config = { apiKey: 'fake-workos', clientId: 'fake-workos-client', base: 'https://workos.test' };
    let memberships = [{ id: SESSION.organization, role: 'member', name: 'Test organization' }];
    const lookups: string[] = [];
    const check = () => gmailUserAllowed(users, config, SESSION.userId, SESSION.organization, (_cfg, userId) => {
      lookups.push(userId);
      return Promise.resolve(memberships);
    });
    expect(await check()).toBe(false);
    expect(lookups).toHaveLength(0);
    await users.setStatus(SESSION.userId, 'approved');
    expect(await check()).toBe(true);
    await users.setStatus(SESSION.userId, 'rejected');
    expect(await check()).toBe(false);
    await users.setStatus(SESSION.userId, 'waitlist');
    expect(await check()).toBe(true);
    memberships = [];
    expect(await check()).toBe(false);
    await users.setStatus(SESSION.userId, 'approved');
    expect(await check()).toBe(false);
    await users.noteLogin({ id: SESSION.userId, email: 'admin@stage.box', name: null, picture: null, createdAt: null }, new Date().toISOString());
    expect(await check()).toBe(false);
    memberships = [{ id: 'org_01OTHERORG0000', role: 'admin', name: 'Other' }];
    expect(await check()).toBe(false);
    expect(await gmailUserAllowed(users, null, SESSION.userId, SESSION.organization)).toBe(false);
    await expect(gmailUserAllowed(users, config, SESSION.userId, SESSION.organization, () => Promise.reject(new Error('WorkOS offline')))).rejects.toThrow('WorkOS offline');
  });
});
