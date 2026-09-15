import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { handleLaunchApiRequest, resetLaunchState, type LaunchApiDeps } from '../src/launch.js';
import type { ConfigResult } from '../src/launch-config.js';
import { ApiError } from '@metro-labs/http/api-error';
import { auth, TEST_OWNER, TEST_STRANGER } from './identity-helper.ts';

const OWNER = TEST_OWNER.address.toLowerCase();

const CONFIG: ConfigResult = {
  ok: true,
  config: {
    credentials: { accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'secret' },
    region: 'eu-west-1',
    tailnet: 'tail17c4f8.ts.net',
    authKey: 'tskey-auth-kABCDEF1CNTRL-abcdefghijklmnop',
    owners: [OWNER],
    perOwner: 2,
  },
};

let config: ConfigResult = CONFIG;
let launched: string[] = [];
let held = 0;
let now = 1_000_000;

const deps: LaunchApiDeps = {
  config: () => config,
  launch: (input) => {
    launched.push(`${input.name} ${input.region} ${input.owner} ${input.tailnet} ${input.authKey}`);
    return Promise.resolve({
      host: 'metro-abc123.tail17c4f8.ts.net',
      node: 'metro-abc123',
      instanceId: 'i-0abc',
      region: input.region,
      zone: null,
      imageId: 'ami-new',
    });
  },
  regions: () => Promise.resolve(['eu-west-1', 'us-east-1']),
  state: (_c, _r, instanceId) => Promise.resolve({ instanceId, state: 'running', publicIp: null }),
  boot: () => Promise.resolve({ steps: [], failed: false, finished: true, lines: ['metro setup: done'], at: null }),
  record: (_subject, launch) =>
    Promise.resolve({
      id: 'srv00000001',
      host: launch.host,
      name: launch.name,
      addedAt: '2026-09-15T00:00:00.000Z',
      instanceId: launch.instanceId,
      launchedAt: '2026-09-15T00:00:00.000Z',
    }),
  count: () => Promise.resolve(held),
  lookup: (_subject, id) =>
    id === 'srv00000001'
      ? Promise.resolve({ instanceId: 'i-0abc', region: 'eu-west-1' })
      : Promise.reject(new ApiError('no such server', 404)),
  now: () => now,
};

let server: Server;
let base = '';

beforeAll(async () => {
  server = createServer((req, res) => {
    if (handleLaunchApiRequest(req, res, deps)) return;
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => {
    server.listen(0, '127.0.0.1', r);
  });
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

afterAll(() => {
  server.close();
});

beforeEach(() => {
  config = CONFIG;
  launched = [];
  held = 0;
  now += 10 * 60_000;
  resetLaunchState();
});

const call = async (method: string, path: string, who = TEST_OWNER, body?: unknown): Promise<Response> =>
  fetch(`${base}${path}`, {
    method,
    headers: {
      authorization: await auth(method, path, who),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

describe('who metro will issue a server to', () => {
  test('an unsigned request is refused before anything is read', async () => {
    expect((await fetch(`${base}/api/launch`)).status).toBe(401);
    expect(launched).toEqual([]);
  });

  test('a wallet outside the allowlist is told nothing beyond a flat no', async () => {
    const overview = await call('GET', '/api/launch', TEST_STRANGER);
    expect(await overview.json()).toEqual({ enabled: false });
    const attempt = await call('POST', '/api/launch', TEST_STRANGER, { name: 'andy' });
    expect(attempt.status).toBe(403);
    expect(launched).toEqual([]);
  });

  test('a deployment with no keys issues nothing, even to the owner', async () => {
    config = { ok: false, missing: ['METRO_AWS_ACCESS_KEY_ID'] };
    expect(await (await call('GET', '/api/launch')).json()).toEqual({ enabled: false });
    const attempt = await call('POST', '/api/launch', TEST_OWNER, { name: 'andy' });
    expect(attempt.status).toBe(404);
    expect(launched).toEqual([]);
  });
});

describe('the overview a wallet on the list sees', () => {
  test('it carries the region, the regions on the account and what is left, never a key', async () => {
    held = 1;
    const body = (await (await call('GET', '/api/launch')).json()) as Record<string, unknown>;
    expect(body).toEqual({ enabled: true, region: 'eu-west-1', regions: ['eu-west-1', 'us-east-1'], remaining: 1 });
    expect(JSON.stringify(body)).not.toContain('AKIA');
    expect(JSON.stringify(body)).not.toContain('tskey');
  });
});

describe('issuing one', () => {
  test('the name and region reach the launcher with the deployment key, and the row comes back', async () => {
    const res = await call('POST', '/api/launch', TEST_OWNER, { name: 'Andy', region: 'us-east-1' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      host: 'metro-abc123.tail17c4f8.ts.net',
      node: 'metro-abc123',
      region: 'us-east-1',
      server: { id: 'srv00000001', instanceId: 'i-0abc' },
    });
    expect(launched).toEqual([`Andy us-east-1 ${OWNER} tail17c4f8.ts.net tskey-auth-kABCDEF1CNTRL-abcdefghijklmnop`]);
  });

  test('no region falls back to the one the deployment configured', async () => {
    await call('POST', '/api/launch', TEST_OWNER, { name: 'Andy' });
    expect(launched[0]).toContain('Andy eu-west-1');
  });

  test('a missing name, and a region that is not one, are refused before AWS is asked', async () => {
    expect((await call('POST', '/api/launch', TEST_OWNER, { name: '  ' })).status).toBe(400);
    expect((await call('POST', '/api/launch', TEST_OWNER, { name: 'a'.repeat(41) })).status).toBe(400);
    expect((await call('POST', '/api/launch', TEST_OWNER, { name: 'ok', region: 'europe' })).status).toBe(400);
    expect(launched).toEqual([]);
  });

  test('the cap per wallet is a refusal, not a silent extra instance', async () => {
    held = 2;
    const res = await call('POST', '/api/launch', TEST_OWNER, { name: 'andy' });
    expect(res.status).toBe(429);
    expect(launched).toEqual([]);
  });

  test('two launches at once from one wallet only ever start one instance', async () => {
    const slow = new Promise<void>((resolve) => setTimeout(resolve, 20));
    deps.launch = async (input) => {
      launched.push(input.name);
      await slow;
      return {
        host: 'metro-abc123.tail17c4f8.ts.net',
        node: 'metro-abc123',
        instanceId: 'i-0abc',
        region: input.region,
        zone: null,
        imageId: 'ami-new',
      };
    };
    const [first, second] = await Promise.all([
      call('POST', '/api/launch', TEST_OWNER, { name: 'one' }),
      call('POST', '/api/launch', TEST_OWNER, { name: 'two' }),
    ]);
    expect([first.status, second.status].sort()).toEqual([200, 409]);
    expect(launched).toHaveLength(1);
  });
});

describe('watching one come up', () => {
  test('the instance state and the boot log are served for a row metro launched', async () => {
    expect(await (await call('GET', '/api/launch/srv00000001')).json()).toMatchObject({ state: 'running' });
    expect(await (await call('GET', '/api/launch/srv00000001/boot')).json()).toMatchObject({ finished: true });
  });

  test('a row that is not this wallet, or not a launch, is a plain refusal', async () => {
    expect((await call('GET', '/api/launch/srv00000002')).status).toBe(404);
    expect((await call('GET', '/api/launch/srv00000001', TEST_STRANGER)).status).toBe(403);
  });

  test('an unknown path under the surface is a 404, and a write to a read route a 405', async () => {
    expect((await call('GET', '/api/launch/srv00000001/nope')).status).toBe(404);
    expect((await call('POST', '/api/launch/srv00000001', TEST_OWNER, {})).status).toBe(405);
  });
});
