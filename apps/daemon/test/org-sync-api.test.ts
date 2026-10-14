import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import type { ConnectorSyncStatus } from '@metro-labs/core/connector-sync';
import { setBearerSessions } from '@metro-labs/http/api-http';
import { SigningKeys } from '@metro-labs/http/workos-token';
import { signAgentRequest } from '@metro-labs/http/agent-signature';
import { fakeIssuer, sessionClaims, type FakeIssuer } from '../../../packages/http/test/workos-fixture.ts';
import { setKeyMap } from '../src/agents/keys.ts';
import { bearerSessionsFor } from '../src/routes/bearer.ts';
import { handleSessionApis } from '../src/routes/session-apis.ts';
import { AGENT, OTHER, OWNER, REVISION, SECRET, SyncControlFixture, URL_SECRET, close, listen, within } from './org-sync-control-fixture.ts';

const PATH = '/api/connectors/sync';
const LOCAL_KEY = 'fixture-local-agent-monitor-key';
let issuer: FakeIssuer;
let keys: SigningKeys;
let f: SyncControlFixture;
let server: Server;
let base = '';
let authenticated: (() => void) | null = null;

beforeAll(async () => {
  issuer = await fakeIssuer();
  keys = new SigningKeys(issuer.url);
});

beforeEach(async () => {
  f = await SyncControlFixture.create();
  authenticated = null;
  setKeyMap([{ key: LOCAL_KEY, agentId: AGENT }]);
  const bearer = bearerSessionsFor(() => f.owner, keys);
  setBearerSessions(async (req) => {
    const session = await bearer(req);
    authenticated?.();
    return session;
  });
  server = createServer((req, res) => {
    if (!handleSessionApis(req, res, { connectorSyncApi: { status: () => f.control.status(), set: (enabled, scope) => f.control.set(enabled, scope) } })) res.writeHead(404).end();
  });
  base = await listen(server);
});

afterEach(async () => {
  setBearerSessions(null);
  setKeyMap([]);
  await close(server);
  await f.cleanup();
});

afterAll(async () => { await issuer.close(); });

const headers = (claims: Record<string, unknown> = {}): Record<string, string> => ({ authorization: `Bearer ${issuer.mint(sessionClaims({ org_id: OWNER, ...claims }))}` });
const get = (auth = headers()): Promise<Response> => fetch(`${base}${PATH}`, { headers: auth });
const put = (body: unknown, auth = headers()): Promise<Response> => fetch(`${base}${PATH}`, { method: 'PUT', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(body) });
const status = async (): Promise<ConnectorSyncStatus> => {
  const response = await get();
  expect(response.status).toBe(200);
  return response.json() as Promise<ConnectorSyncStatus>;
};

function safe(value: unknown): void {
  const text = JSON.stringify(value);
  for (const secret of [SECRET, URL_SECRET, REVISION, 'Private organization MCP', LOCAL_KEY, f.key?.keyId, f.key?.signingKey, f.key?.sealingKey]) {
    if (secret !== undefined) expect(text).not.toContain(secret);
  }
}

test('a genuine WorkOS admin reads and toggles its own organization over HTTP with secret-free status', async () => {
  const before = await status();
  expect(before).toMatchObject({ enabled: false, source: 'default', state: 'off', enrolled: true, owner: OWNER, agentId: AGENT, liveEnabled: false, counts: null });
  expect(before.scope).toMatch(/^[a-f0-9]{64}$/);
  expect(f.calls).toEqual([]);
  const enabled = await put({ enabled: true, scope: before.scope });
  expect(enabled.status).toBe(200);
  safe(await enabled.json());
  await f.control.poll();
  const received = await status();
  expect(received).toMatchObject({ enabled: true, source: 'saved', state: 'received', counts: { total: 2, ready: 1, unavailable: 1 }, lastReceivedAt: f.now, leaseExpiresAt: f.now + 90_000 });
  expect(Object.keys(received).sort()).toEqual(['agentId', 'counts', 'enabled', 'enrolled', 'lastReceivedAt', 'leaseExpiresAt', 'liveEnabled', 'owner', 'scope', 'source', 'state'].sort());
  safe(received);
  expect(f.calls.length).toBeGreaterThan(0);
  expect(f.calls.every((call) => call.signatureValid)).toBe(true);
  const disabled = await put({ enabled: false, scope: received.scope });
  expect(disabled.status).toBe(200);
  expect(await disabled.json()).toMatchObject({ enabled: false, source: 'saved', state: 'off', counts: null, lastReceivedAt: null, leaseExpiresAt: null });
});

test('member, monitor-role, wrong-organization and organization-free WorkOS tokens cannot read or change sync', async () => {
  const before = f.files();
  for (const claims of [{ role: 'member' }, { role: 'monitor' }, { org_id: OTHER }, { org_id: undefined }]) {
    for (const method of ['GET', 'PUT']) {
      const auth = headers(claims);
      const response = method === 'GET' ? await get(auth) : await put({ enabled: true, scope: f.control.status().scope }, auth);
      expect(response.status).toBe(403);
      const value: unknown = await response.json();
      safe(value);
      expect(value).not.toHaveProperty('scope');
      expect(value).not.toHaveProperty('counts');
    }
  }
  expect(f.files()).toEqual(before);
  expect(f.calls).toEqual([]);
});

test('local agent and monitor bearer keys, signed agent requests, cookies and expired sessions are not admin auth', async () => {
  const token = issuer.mint(sessionClaims({ org_id: OWNER }));
  const key = f.key;
  if (key === null) throw new Error('missing fixture key');
  const signed = signAgentRequest({ method: 'GET', host: new URL(base).host, path: PATH, body: Buffer.alloc(0) }, key.signing, key.keyId, Date.now());
  const credentials = [{}, { authorization: `Bearer ${LOCAL_KEY}` }, { authorization: signed }, { cookie: `session=${token}; access_token=${token}; authorization=Bearer ${token}` }, headers({ exp: Math.floor(Date.now() / 1000) - 300 }), { authorization: 'Bearer not.a.valid.signature' }];
  for (const auth of credentials) {
    expect((await get(auth)).status).toBe(401);
    expect((await put({ enabled: true, scope: f.control.status().scope }, auth)).status).toBe(401);
  }
  expect((await fetch(`${base}${PATH}?token=${LOCAL_KEY}`)).status).toBe(401);
  expect((await fetch(`${base}${PATH}?access_token=${token}`)).status).toBe(401);
  expect(existsSync(f.setting)).toBe(false);
  expect(f.calls).toEqual([]);
});

test('preflight and both successful and denied responses have CORS, never cookies or credentialed CORS', async () => {
  const origin = 'https://metro.example';
  const preflight = await fetch(`${base}${PATH}`, { method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'PUT', 'access-control-request-headers': 'authorization,content-type', 'access-control-request-private-network': 'true' } });
  expect(preflight.status).toBe(204);
  expect(preflight.headers.get('access-control-allow-methods')).toContain('PUT');
  expect(preflight.headers.get('access-control-allow-headers')?.toLowerCase()).toContain('authorization');
  expect(preflight.headers.get('access-control-allow-private-network')).toBe('true');
  for (const response of [preflight, await get({ origin, ...headers() }), await get({ origin }), await put({ enabled: false, scope: f.control.status().scope }, { origin, ...headers({ role: 'member' }) })]) {
    expect(response.headers.get('access-control-allow-origin')).toBe(origin);
    expect(response.headers.get('vary')).toContain('Origin');
    expect(response.headers.get('access-control-allow-credentials')).toBeNull();
    expect(response.headers.get('set-cookie')).toBeNull();
    if (response.status !== 204) expect(response.headers.get('cache-control')).toBe('no-store');
    await response.text();
  }
  expect(f.calls).toEqual([]);
});

test('GET never polls, even with sync enabled, and unsupported methods do not mutate', async () => {
  process.env.METRO_CONNECTORS_SYNC_ENABLED = 'true';
  f.restart();
  for (let i = 0; i < 3; i += 1) expect(await status()).toMatchObject({ enabled: true, state: 'waiting', counts: null, lastReceivedAt: null });
  for (const method of ['POST', 'DELETE', 'PATCH']) expect((await fetch(`${base}${PATH}`, { method, headers: headers() })).status).toBe(405);
  expect(f.calls).toEqual([]);
  expect(existsSync(f.setting)).toBe(false);
});

test('PUT accepts exactly boolean enabled and the current scope, not missing or extra fields', async () => {
  const scope = (await status()).scope;
  for (const body of [null, [], {}, { enabled: true }, { scope }, { enabled: 'true', scope }, { enabled: 1, scope }, { enabled: true, scope: 'short' }, { enabled: true, scope, liveEnabled: true }, { enabled: true, scope, owner: OTHER }]) {
    expect((await put(body)).status).toBe(400);
  }
  expect((await fetch(`${base}${PATH}`, { method: 'PUT', headers: headers(), body: '{bad' })).status).toBe(400);
  expect((await put({ enabled: true, scope: 'f'.repeat(64) })).status).toBe(409);
  expect(existsSync(f.setting)).toBe(false);
  expect(f.calls).toEqual([]);
});

test('unenrolled requests refuse ON with 409 but still permit OFF', async () => {
  f.key = null;
  const unenrolled = await status();
  expect((await put({ enabled: true, scope: unenrolled.scope })).status).toBe(409);
  expect((await put({ enabled: false, scope: unenrolled.scope })).status).toBe(200);
  expect(f.calls).toEqual([]);
  expect(await status()).toMatchObject({ enabled: false, state: 'off', liveEnabled: false });
});

test('a failed setting write returns a sanitized 503 without enabling or polling', async () => {
  const scope = (await status()).scope;
  mkdirSync(f.setting);
  const response = await put({ enabled: true, scope });
  expect(response.status).toBe(503);
  safe(await response.json());
  expect(f.control.status()).toMatchObject({ enabled: false, state: 'off', source: 'invalid' });
  expect(f.calls).toEqual([]);
});

async function delayedPut(change: () => void): Promise<number> {
  const body = JSON.stringify({ enabled: true, scope: (await status()).scope });
  const accepted = Promise.withResolvers<void>();
  authenticated = accepted.resolve;
  const reply = Promise.withResolvers<number>();
  const req = request(`${base}${PATH}`, { method: 'PUT', headers: { ...headers(), 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (res) => {
    res.resume();
    res.once('end', () => { reply.resolve(res.statusCode ?? 0); });
  });
  req.once('error', reply.reject);
  req.flushHeaders();
  try {
    await within(accepted.promise);
    change();
    req.end(body);
    return await within(reply.promise);
  } finally {
    req.destroy();
    authenticated = null;
  }
}

test('the current owner is checked again after the PUT body arrives, not only when its bearer is accepted', async () => {
  expect(await delayedPut(() => { f.owner = OTHER; f.control.invalidate(); })).toBe(403);
  expect(existsSync(f.setting)).toBe(false);
  expect(f.calls).toEqual([]);
});

test('an owner away-and-back event rejects an already authenticated stale PUT with 409', async () => {
  expect(await delayedPut(() => {
    f.owner = OTHER;
    f.control.invalidate();
    f.owner = OWNER;
    f.control.invalidate();
  })).toBe(409);
  expect(existsSync(f.setting)).toBe(false);
  expect(f.calls).toEqual([]);
});

test('HTTP saved OFF remains authoritative across daemon restart with environment ON', async () => {
  const scope = (await status()).scope;
  expect((await put({ enabled: false, scope })).status).toBe(200);
  const saved = readFileSync(f.setting, 'utf8');
  process.env.METRO_CONNECTORS_SYNC_ENABLED = 'true';
  f.restart().start();
  await f.control.poll();
  expect(await status()).toMatchObject({ enabled: false, source: 'saved', state: 'off', counts: null });
  expect(readFileSync(f.setting, 'utf8')).toBe(saved);
  expect(f.calls).toEqual([]);
});
