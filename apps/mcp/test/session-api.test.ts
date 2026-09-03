import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { makeEmit, startWebhookServer } from '../src/daemon/http.ts';
import { signSession } from '../src/daemon/session.ts';
import { setKeyMap } from '../src/db/key-map.ts';

const SECRET = 'session-api-secret';
let server: Server;
let base = '';
let savedSecret: string | undefined;
let savedHost: string | undefined;

const session = (email: string, secret = SECRET, ttlSec?: number): string =>
  signSession(
    { email, agentIds: [] },
    secret,
    ttlSec === undefined ? undefined : { ttlSec },
  );

const get = (token?: string): Promise<Response> =>
  fetch(`${base}/api/session`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });

beforeAll(async () => {
  savedSecret = process.env.METRO_SESSION_SECRET;
  savedHost = process.env.METRO_HTTP_HOST;
  process.env.METRO_SESSION_SECRET = SECRET;
  process.env.METRO_HTTP_HOST = '127.0.0.1';
  process.env.METRO_WEBHOOK_PORT = String(10000 + Math.floor(Math.random() * 20000));
  server = await startWebhookServer(makeEmit());
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

describe('GET /api/session is the boot gate', () => {
  test('a valid session returns the email the JWT was signed for', async () => {
    const res = await get(session('ada@lovelace.dev'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ email: 'ada@lovelace.dev' });
  });

  test('the email is lowercased, so it matches every other API', async () => {
    const res = await get(session('Ada@Lovelace.DEV'));
    expect(await res.json()).toEqual({ email: 'ada@lovelace.dev' });
  });

  test('no token is a 401', async () => {
    expect((await get()).status).toBe(401);
  });

  test('a token signed with another secret is a 401 — this is the whole point', async () => {
    const res = await get(session('ada@lovelace.dev', 'not-the-secret'));
    expect(res.status).toBe(401);
  });

  test('a structurally valid but tampered token is a 401', async () => {
    const [head, , sig] = session('ada@lovelace.dev').split('.');
    const forged = btoa(
      JSON.stringify({ sub: 'mallory@evil.dev', exp: 9_999_999_999 }),
    )
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    const res = await get(`${head ?? ''}.${forged}.${sig ?? ''}`);
    expect(res.status).toBe(401);
  });

  test('an expired token is a 401', async () => {
    const res = await get(session('ada@lovelace.dev', SECRET, -10));
    expect(res.status).toBe(401);
  });

  test('an agent key never opens this surface — it is session-only', async () => {
    setKeyMap([{ key: 'mk_session_probe', agentId: 'agent000001' }]);
    try {
      expect((await get('mk_session_probe')).status).toBe(401);
    } finally {
      setKeyMap([]);
    }
  });

  test('?token= works, matching the other session routes', async () => {
    const url = `${base}/api/session?token=${encodeURIComponent(session('ada@lovelace.dev'))}`;
    expect((await fetch(url)).status).toBe(200);
  });

  test('OPTIONS is a 204 preflight', async () => {
    const res = await fetch(`${base}/api/session`, { method: 'OPTIONS' });
    expect(res.status).toBe(204);
  });

  test('a wrong method is a 405, decided before auth', async () => {
    const res = await fetch(`${base}/api/session`, { method: 'POST' });
    expect(res.status).toBe(405);
  });

  test('/health still answers, so the gate did not shadow it', async () => {
    expect((await fetch(`${base}/health`)).status).toBe(200);
  });
});
