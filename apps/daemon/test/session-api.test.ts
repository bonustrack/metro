import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { bootDaemon, type Daemon } from './http-harness.ts';
import { setKeyMap } from '../src/agents/keys.ts';
import { auth, bearer, forged } from './identity-helper.ts';

let daemon: Daemon;
let base = '';
const get = async (who?: Who, at?: number): Promise<Response> =>
  fetch(`${base}/api/session`, {
    headers: who === undefined ? {} : { authorization: await auth(who, at) },
  });

beforeAll(async () => {
  daemon = await bootDaemon();
  base = daemon.base;
});

afterAll(async () => {
  await daemon.close();
});

describe('GET /api/session is the boot gate', () => {
  test('a registered identity answers with the subject it acts for', async () => {
    const res = await get('ada@lovelace.dev');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ subject: 'ada@lovelace.dev', role: 'admin' });
  });

  test('the subject is lowercased, so it matches every other API', async () => {
    const res = await get('Ada@Lovelace.DEV');
    expect(await res.json()).toEqual({ subject: 'ada@lovelace.dev', role: 'admin' });
  });

  test('no header is a 401', async () => {
    expect((await get()).status).toBe(401);
  });

  test('a token nobody issued is a 401, however well it is shaped', async () => {
    expect((await fetch(`${base}/api/session`, { headers: { authorization: await forged() } })).status).toBe(401);
  });

  test('a token with no organization is a 401', async () => {
    expect((await fetch(`${base}/api/session`, { headers: { authorization: await bearer({ org_id: undefined, role: undefined }) } })).status).toBe(401);
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
