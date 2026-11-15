import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomInt } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { dropPushTokens, PUSH_DEVICES_MAX, pushTokensOf } from '../src/db/push-devices.ts';
import { handlePushDevicesRequest } from '../src/push-devices.ts';
import { pushDevices } from '../src/db/schema.ts';
import { bearer, testKeys, TEST_OWNER } from './identity-helper.ts';
import { PGLITE_START_MS, PGLITE_STEP_MS, testDb, type TestDb } from './pglite-db.ts';

const NOW = Date.parse('2026-11-15T09:00:00.000Z');
const ALICE = 'user_01ALICE';
const BOB = 'user_01BOB';

let held: TestDb;
let server: Server;
let base = '';
let now = NOW;

const tokenOf = (n: number): string => `ExponentPushToken[device${String(n).padStart(6, '0')}abcdef]`;

async function call(method: string, body: unknown, who: string | null = ALICE): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (who !== null) headers.authorization = await bearer({ sub: who, org_id: TEST_OWNER });
  return fetch(`${base}/api/push/devices`, { method, headers, body: JSON.stringify(body) });
}

const register = (n: number, who = ALICE): Promise<Response> => call('POST', { token: tokenOf(n), platform: 'android' }, who);

beforeAll(async () => {
  held = await testDb();
  const keys = await testKeys();
  server = createServer((req, res) => {
    if (!handlePushDevicesRequest(req, res, { keys, db: () => held.db, now: () => now })) res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => {
    server.listen(randomInt(10_000, 30_000), '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
}, PGLITE_START_MS);

beforeEach(async () => {
  now = NOW;
  await held.reset();
}, PGLITE_STEP_MS);

afterAll(async () => {
  server.close();
  await held.close();
});

describe('POST /api/push/devices', () => {
  test('a signed-in user registers a device, and the answer never carries the token', async () => {
    const res = await register(1);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ registered: true });
    expect(text).not.toContain('ExponentPushToken');
    expect(await pushTokensOf(held.db, [ALICE])).toEqual([tokenOf(1)]);
  });

  test('no bearer is a 401 and nothing is stored', async () => {
    expect((await call('POST', { token: tokenOf(1), platform: 'android' }, null)).status).toBe(401);
    expect(await pushTokensOf(held.db, [ALICE])).toEqual([]);
  });

  test('a token that is not an Expo push token, or an unknown platform, is a 400', async () => {
    expect((await call('POST', { token: 'not-a-token', platform: 'android' })).status).toBe(400);
    expect((await call('POST', { token: 'ExponentPushToken[]', platform: 'android' })).status).toBe(400);
    expect((await call('POST', { token: tokenOf(1), platform: 'web' })).status).toBe(400);
    expect((await call('POST', { platform: 'android' })).status).toBe(400);
    expect(await pushTokensOf(held.db, [ALICE])).toEqual([]);
  });

  test('registering the same token again only refreshes it, and another user takes it over', async () => {
    await register(1);
    now += 60_000;
    await register(1);
    const rows = await held.db.select().from(pushDevices);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: ALICE, lastSeenAt: NOW + 60_000, createdAt: NOW });
    await register(1, BOB);
    expect(await pushTokensOf(held.db, [ALICE])).toEqual([]);
    expect(await pushTokensOf(held.db, [BOB])).toEqual([tokenOf(1)]);
  });

  test(`a user keeps at most ${String(PUSH_DEVICES_MAX)} devices: the one seen least recently goes`, async () => {
    for (let n = 0; n < PUSH_DEVICES_MAX; n += 1) {
      now = NOW + n;
      expect((await register(n)).status).toBe(200);
    }
    now = NOW + 100;
    await register(0);
    now = NOW + 200;
    await register(99);
    const kept = await pushTokensOf(held.db, [ALICE]);
    expect(kept).toHaveLength(PUSH_DEVICES_MAX);
    expect(kept).toContain(tokenOf(0));
    expect(kept).toContain(tokenOf(99));
    expect(kept).not.toContain(tokenOf(1));
  });

  test('the cap is per user', async () => {
    for (let n = 0; n < PUSH_DEVICES_MAX; n += 1) await register(n);
    await register(500, BOB);
    expect(await pushTokensOf(held.db, [ALICE])).toHaveLength(PUSH_DEVICES_MAX);
    expect(await pushTokensOf(held.db, [BOB])).toEqual([tokenOf(500)]);
  });
});

describe('DELETE /api/push/devices', () => {
  test('a user removes their own device', async () => {
    await register(1);
    const res = await call('DELETE', { token: tokenOf(1) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ removed: true });
    expect(await held.db.select().from(pushDevices).where(eq(pushDevices.token, tokenOf(1)))).toEqual([]);
  });

  test("another user cannot remove someone's device", async () => {
    await register(1);
    expect(await (await call('DELETE', { token: tokenOf(1) }, BOB)).json()).toEqual({ removed: false });
    expect(await pushTokensOf(held.db, [ALICE])).toEqual([tokenOf(1)]);
  });

  test('a malformed token is a 400 and no bearer is a 401', async () => {
    expect((await call('DELETE', { token: 'nope' })).status).toBe(400);
    expect((await call('DELETE', { token: tokenOf(1) }, null)).status).toBe(401);
  });

  test('other methods are refused', async () => {
    const res = await fetch(`${base}/api/push/devices`, { method: 'GET', headers: { authorization: await bearer({ sub: ALICE, org_id: TEST_OWNER }) } });
    expect(res.status).toBe(405);
  });
});

describe('the sender store', () => {
  test('tokens are read for a set of users and dropped by token', async () => {
    await register(1);
    await register(2, BOB);
    expect(await pushTokensOf(held.db, [ALICE, BOB])).toEqual([tokenOf(1), tokenOf(2)]);
    expect(await pushTokensOf(held.db, [])).toEqual([]);
    expect(await dropPushTokens(held.db, [tokenOf(2)])).toBe(1);
    expect(await pushTokensOf(held.db, [ALICE, BOB])).toEqual([tokenOf(1)]);
  });
});
