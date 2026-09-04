import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { makeEmit, startWebhookServer } from '../src/daemon/http.ts';
import { setKeyMap } from '../src/db/key-map.ts';
import { auth, TEST_STRANGER, type Who } from './identity-helper.ts';

let server: Server;
let base = '';
let savedHost: string | undefined;
const get = async (who?: Who, at?: number): Promise<Response> =>
  fetch(`${base}/api/session`, {
    headers: who === undefined ? {} : { authorization: await auth('GET', '/api/session', who, at) },
  });

beforeAll(async () => {
  savedHost = process.env.METRO_HTTP_HOST;
  process.env.METRO_HTTP_HOST = '127.0.0.1';
  process.env.METRO_WEBHOOK_PORT = String(10000 + Math.floor(Math.random() * 20000));
  server = await startWebhookServer(makeEmit());
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

afterAll(async () => {
  if (savedHost === undefined) delete process.env.METRO_HTTP_HOST;
  else process.env.METRO_HTTP_HOST = savedHost;
  await new Promise<void>((r) => {
    server.close(() => {
      r();
    });
  });
});

describe('GET /api/session is the boot gate', () => {
  test('a registered identity answers with the subject it acts for', async () => {
    const res = await get('ada@lovelace.dev');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ subject: 'ada@lovelace.dev' });
  });

  test('the subject is lowercased, so it matches every other API', async () => {
    const res = await get('Ada@Lovelace.DEV');
    expect(await res.json()).toEqual({ subject: 'ada@lovelace.dev' });
  });

  test('no header is a 401', async () => {
    expect((await get()).status).toBe(401);
  });

  test('an identity nobody registered is a 401, however well it signs', async () => {
    expect((await get(TEST_STRANGER)).status).toBe(401);
  });

  test('a signature older than five minutes is a 401', async () => {
    expect((await get('ada@lovelace.dev', Date.now() - 6 * 60_000)).status).toBe(401);
  });

  test('an agent key never opens this surface, and neither does a query token', async () => {
    setKeyMap([{ key: 'mk_session_probe', agentId: 'agent000001' }]);
    try {
      expect((await fetch(`${base}/api/session`, { headers: { authorization: 'Bearer mk_session_probe' } })).status).toBe(401);
      expect((await fetch(`${base}/api/session?token=mk_session_probe`)).status).toBe(401);
    } finally {
      setKeyMap([]);
    }
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
