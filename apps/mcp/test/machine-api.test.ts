import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { hostname } from 'node:os';
import { handleMachineRequest, machineInfo } from '../src/daemon/machine-api.js';
import { ApiError } from '../src/daemon/api-error.js';
import { auth, TEST_STRANGER } from './identity-helper.ts';

const OWNER = '0xef8305e140ac520225daf050e2f71d5fbcc543e7';
let server: Server;
let base = '';
const saved = { store: process.env.METRO_RUNTIME_STORE, pub: process.env.METRO_PUBLIC_URL };

beforeAll(async () => {
  process.env.METRO_RUNTIME_STORE = '/home/u/.metro/runtime';
  process.env.METRO_PUBLIC_URL = 'https://metro-abc123.tail1234.ts.net/';
  server = createServer((req, res) => {
    if (
      handleMachineRequest(req, res, {
        authorize: (subject) => {
          if (subject !== OWNER) throw new ApiError('no such project', 404);
        },
        startedAt: '2026-09-05T20:00:00.000Z',
      })
    )
      return;
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => {
    server.listen(0, '127.0.0.1', r);
  });
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

afterAll(() => {
  server.close();
  if (saved.store === undefined) delete process.env.METRO_RUNTIME_STORE;
  else process.env.METRO_RUNTIME_STORE = saved.store;
  if (saved.pub === undefined) delete process.env.METRO_PUBLIC_URL;
  else process.env.METRO_PUBLIC_URL = saved.pub;
});

describe('what a daemon says about its machine', () => {
  test('the owner reads the version, the public address, the port, the machine and the paths', async () => {
    const res = await fetch(`${base}/api/server`, { headers: { authorization: await auth('GET', '/api/server', OWNER) } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      hostname: hostname(),
      platform: process.platform,
      arch: process.arch,
      publicUrl: 'https://metro-abc123.tail1234.ts.net',
      startedAt: '2026-09-05T20:00:00.000Z',
      runtimeStore: '/home/u/.metro/runtime',
    });
    expect(typeof body.version).toBe('string');
    expect(typeof body.port).toBe('number');
    expect(typeof body.uptimeSeconds).toBe('number');
    expect(typeof body.agentsDir).toBe('string');
    expect(typeof body.claudeDir).toBe('string');
    expect(machineInfo().uptimeSeconds).toBeGreaterThanOrEqual(0);
  });

  test('no signature is 401, a stranger is 404, a wrong method 405, preflight passes', async () => {
    expect((await fetch(`${base}/api/server`)).status).toBe(401);
    expect((await fetch(`${base}/api/server`, { headers: { authorization: await auth('GET', '/api/server', TEST_STRANGER) } })).status).toBe(401);
    expect((await fetch(`${base}/api/server`, { headers: { authorization: await auth('GET', '/api/server', 'someone@else.test') } })).status).toBe(404);
    expect((await fetch(`${base}/api/server`, { method: 'POST' })).status).toBe(405);
    expect((await fetch(`${base}/api/server`, { method: 'OPTIONS' })).status).toBe(204);
  });
});
