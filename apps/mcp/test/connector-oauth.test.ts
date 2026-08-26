import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { makeEmit, startWebhookServer } from '../src/daemon/http.ts';
import { signSession } from '../src/daemon/session.ts';
import { authorizeUrl, challengeOf, newVerifier } from '../src/daemon/oauth-client.ts';
import { resourceMetadataUrls } from '../src/daemon/oauth-discovery.ts';
import {
  pendingCount,
  startPending,
  takePending,
} from '../src/daemon/oauth-pending.ts';
import { oauthExpired } from '../src/daemon/connector-oauth.ts';

const SECRET = 'connector-oauth-secret';
let server: Server;
let base = '';
let savedSecret: string | undefined;
let savedHost: string | undefined;

const SERVER = {
  issuer: 'https://as.example.com/',
  authorizationEndpoint: 'https://as.example.com/authorize',
  tokenEndpoint: 'https://as.example.com/token',
  registrationEndpoint: 'https://as.example.com/register',
  supportsS256: true,
};

const CLIENT = { clientId: 'client-abc' };

const PENDING = {
  email: 'ada@lovelace.dev',
  name: 'snapshot',
  url: 'https://mcp.example.com/',
  resource: 'https://mcp.example.com/',
  returnTo: 'https://metro.box/',
  verifier: 'v'.repeat(43),
  server: SERVER,
  client: CLIENT,
};

const deps = {
  listConnectors: () => Promise.resolve([]),
  createConnector: () => Promise.reject(new Error('not exercised')),
  createOAuthConnector: () => Promise.reject(new Error('not exercised')),
  verifyConnector: () => Promise.reject(new Error('not exercised')),
  deleteConnector: () => Promise.reject(new Error('not exercised')),
};

beforeAll(async () => {
  savedSecret = process.env.METRO_SESSION_SECRET;
  savedHost = process.env.METRO_HTTP_HOST;
  process.env.METRO_SESSION_SECRET = SECRET;
  process.env.METRO_HTTP_HOST = '127.0.0.1';
  process.env.METRO_WEBHOOK_PORT = String(20000 + Math.floor(Math.random() * 20000));
  server = await startWebhookServer(makeEmit(), { connectorApi: deps });
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

afterAll(async () => {
  if (savedSecret === undefined) delete process.env.METRO_SESSION_SECRET;
  else process.env.METRO_SESSION_SECRET = savedSecret;
  if (savedHost === undefined) delete process.env.METRO_HTTP_HOST;
  else process.env.METRO_HTTP_HOST = savedHost;
  await new Promise<void>((r) => {
    server.close(() => {
      r();
    });
  });
});

describe('PKCE', () => {
  test('challengeOf matches the RFC 7636 appendix B vector', () => {
    expect(challengeOf('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });

  test('a verifier is base64url and long enough to be unguessable', () => {
    const v = newVerifier();
    expect(v).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(newVerifier()).not.toBe(v);
  });
});

describe('the authorize url', () => {
  test('carries S256, the challenge, the state and the resource', () => {
    const url = new URL(
      authorizeUrl({
        server: SERVER,
        client: CLIENT,
        redirectUri: 'https://mcp.metro.box/api/connectors/callback',
        state: 'st-1',
        verifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
        resource: 'https://mcp.example.com/',
      }),
    );
    expect(url.origin + url.pathname).toBe('https://as.example.com/authorize');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
    expect(url.searchParams.get('state')).toBe('st-1');
    expect(url.searchParams.get('resource')).toBe('https://mcp.example.com/');
    expect(url.searchParams.get('redirect_uri')).toBe(
      'https://mcp.metro.box/api/connectors/callback',
    );
  });

  test('the verifier itself never appears in the url', () => {
    const verifier = newVerifier();
    const url = authorizeUrl({
      server: SERVER,
      client: CLIENT,
      redirectUri: 'https://mcp.metro.box/api/connectors/callback',
      state: 'st-2',
      verifier,
      resource: 'https://mcp.example.com/',
    });
    expect(url).not.toContain(verifier);
  });
});

describe('discovery url derivation', () => {
  test('a path-less resource looks only at the root well-known', () => {
    const urls = resourceMetadataUrls(new URL('https://mcp.example.com/'));
    expect(urls.map((u) => u.pathname)).toEqual([
      '/.well-known/oauth-protected-resource',
    ]);
  });

  test('a resource with a path tries the path-aware form FIRST', () => {
    const urls = resourceMetadataUrls(new URL('https://mcp.example.com/mcp'));
    expect(urls.map((u) => u.pathname)).toEqual([
      '/.well-known/oauth-protected-resource/mcp',
      '/.well-known/oauth-protected-resource',
    ]);
  });
});

describe('the pending store', () => {
  test('a state is single-use — a replay finds nothing', () => {
    const state = startPending(PENDING);
    expect(takePending(state)?.email).toBe('ada@lovelace.dev');
    expect(takePending(state)).toBeUndefined();
  });

  test('an expired entry is not honoured', () => {
    const state = startPending(PENDING, 1_000);
    expect(takePending(state, 1_000 + 11 * 60_000)).toBeUndefined();
  });

  test('an unknown state is simply undefined', () => {
    expect(takePending('nope')).toBeUndefined();
  });

  test('states are unguessable and distinct', () => {
    const a = startPending(PENDING);
    const b = startPending(PENDING);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    takePending(a);
    takePending(b);
  });

  test('the store does not grow without bound', () => {
    const before = pendingCount();
    for (let i = 0; i < 150; i += 1) startPending(PENDING);
    expect(pendingCount()).toBeLessThanOrEqual(100);
    expect(pendingCount()).toBeGreaterThan(before);
  });
});

describe('token expiry', () => {
  const auth = {
    kind: 'oauth' as const,
    accessToken: 'at',
    issuer: 'https://as.example.com/',
    tokenEndpoint: 'https://as.example.com/token',
    clientId: 'c',
  };

  test('no expiry means never stale', () => {
    expect(oauthExpired(auth)).toBe(false);
  });

  test('it goes stale five minutes BEFORE the deadline, not after', () => {
    const expiresAt = 1_000_000;
    expect(oauthExpired({ ...auth, expiresAt }, expiresAt - 360_000)).toBe(false);
    expect(oauthExpired({ ...auth, expiresAt }, expiresAt - 240_000)).toBe(true);
    expect(oauthExpired({ ...auth, expiresAt }, expiresAt + 1)).toBe(true);
  });
});

describe('the callback route', () => {
  const callback = (query: string): Promise<Response> =>
    fetch(`${base}/api/connectors/callback?${query}`, { redirect: 'manual' });

  test('it is NOT session gated — the browser arrives with no token', async () => {
    const res = await callback('state=unknown');
    expect(res.status).not.toBe(401);
    expect(res.status).toBe(400);
  });

  test('an unknown state is refused, not redirected anywhere', async () => {
    const res = await callback('state=unknown&code=abc');
    expect(res.status).toBe(400);
    expect(res.headers.get('location')).toBeNull();
  });

  test('a denied consent sends the user back with the reason', async () => {
    const state = startPending(PENDING);
    const res = await callback(`state=${state}&error=access_denied`);
    expect(res.status).toBe(302);
    const location = res.headers.get('location') ?? '';
    expect(location.startsWith('https://metro.box/')).toBe(true);
    expect(location).toContain('connector_error=access_denied');
    expect(location.endsWith('#/connectors')).toBe(true);
  });

  test('a missing code sends the user back rather than hanging', async () => {
    const state = startPending(PENDING);
    const res = await callback(`state=${state}`);
    expect(res.status).toBe(302);
    expect(res.headers.get('location') ?? '').toContain('connector_error=');
  });

  test('the state is consumed even on the error path, so it cannot be replayed', async () => {
    const state = startPending(PENDING);
    await callback(`state=${state}&error=access_denied`);
    const again = await callback(`state=${state}&error=access_denied`);
    expect(again.status).toBe(400);
  });

  test('POST to the callback is a 405', async () => {
    const res = await fetch(`${base}/api/connectors/callback`, { method: 'POST' });
    expect(res.status).toBe(405);
  });

  test('the collection route is still session gated', async () => {
    expect((await fetch(`${base}/api/connectors?project=p0000000001`)).status).toBe(
      401,
    );
    const token = signSession({ email: 'ada@lovelace.dev', agentIds: [] }, SECRET);
    const ok = await fetch(`${base}/api/connectors?project=p0000000001`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(ok.status).toBe(200);
  });
});
