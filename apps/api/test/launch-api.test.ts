import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { handleLaunchApiRequest, resetLaunchState, type LaunchApiDeps } from '../src/launch.js';
import { AwsError } from '../src/aws/ec2.js';
import type { ConfigResult } from '../src/launch-config.js';
import { ApiError } from '@metro-labs/http/api-error';
import { auth, testKeys, TEST_OWNER, TEST_STRANGER } from './identity-helper.ts';
import { SigningKeys } from '@metro-labs/http/workos-token';

const OWNER = TEST_OWNER;
const WALLET = 'org_01BOXOWNER0000000';

const CONFIG: ConfigResult = {
  ok: true,
  config: {
    credentials: { accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'secret' },
    tailnet: 'tail17c4f8.ts.net',
    authKey: 'tskey-auth-kABCDEF1CNTRL-abcdefghijklmnop',
  },
};

let config: ConfigResult = CONFIG;
let launched: string[] = [];
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
      avatar: null,
    }),
  lookup: (subject, id) =>
    subject === TEST_OWNER && id === 'srv00000001'
      ? Promise.resolve({ instanceId: 'i-0abc', region: 'eu-west-1' })
      : Promise.reject(new ApiError('no such server', 404)),
  now: () => now,
  keys: new SigningKeys('http://127.0.0.1:1/nowhere'),
};

let server: Server;
let base = '';

beforeAll(async () => {
  deps.keys = await testKeys();
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

  test('any signed-in organization may ask; there is no allowlist any more', async () => {
    const overview = await call('GET', '/api/launch', TEST_STRANGER);
    expect(((await overview.json()) as { enabled: boolean }).enabled).toBe(true);
  });

  test('a deployment with no keys issues nothing, even to the owner', async () => {
    config = { ok: false, missing: ['METRO_AWS_ACCESS_KEY_ID'] };
    expect(await (await call('GET', '/api/launch')).json()).toEqual({ enabled: false });
    const attempt = await call('POST', '/api/launch', TEST_OWNER, { name: 'andy', region: 'eu-west-1', owner: WALLET });
    expect(attempt.status).toBe(404);
    expect(launched).toEqual([]);
  });
});

describe('the overview a wallet on the list sees', () => {
  test('it carries the regions on the account, never a key', async () => {
    const body = (await (await call('GET', '/api/launch')).json()) as Record<string, unknown>;
    expect(body).toEqual({ enabled: true, regions: ['eu-west-1', 'us-east-1'] });
    expect(JSON.stringify(body)).not.toContain('AKIA');
    expect(JSON.stringify(body)).not.toContain('tskey');
  });
});

describe('issuing one', () => {
  test('the box is owned by the organization that signed the request, whatever owner the body names', async () => {
    const res = await call('POST', '/api/launch', TEST_OWNER, { name: 'Andy', region: 'us-east-1', owner: WALLET });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      host: 'metro-abc123.tail17c4f8.ts.net',
      node: 'metro-abc123',
      region: 'us-east-1',
      server: { id: 'srv00000001', instanceId: 'i-0abc' },
    });
    expect(launched).toEqual([`Andy us-east-1 ${OWNER} tail17c4f8.ts.net tskey-auth-kABCDEF1CNTRL-abcdefghijklmnop`]);
    expect(launched[0]).not.toContain(WALLET);
  });

  test('a missing name or region is refused before AWS is asked', async () => {
    const region = 'eu-west-1';
    expect((await call('POST', '/api/launch', TEST_OWNER, { name: '  ', region })).status).toBe(400);
    expect((await call('POST', '/api/launch', TEST_OWNER, { name: 'a'.repeat(41), region })).status).toBe(400);
    expect((await call('POST', '/api/launch', TEST_OWNER, { name: 'ok', region: 'europe' })).status).toBe(400);
    expect((await call('POST', '/api/launch', TEST_OWNER, { name: 'ok' })).status).toBe(400);
    expect(launched).toEqual([]);
  });

  test('what AWS refuses reaches the page in its own words, not a generic failure', async () => {
    const was = deps.launch;
    deps.launch = () =>
      Promise.reject(new AwsError('Unsupported', 'The specified instance type is not eligible for Free Tier.'));
    const res = await call('POST', '/api/launch', TEST_OWNER, { name: 'andy', region: 'eu-west-1', owner: WALLET });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('not eligible for Free Tier');
    deps.launch = was;
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
      call('POST', '/api/launch', TEST_OWNER, { name: 'one', region: 'eu-west-1', owner: WALLET }),
      call('POST', '/api/launch', TEST_OWNER, { name: 'two', region: 'eu-west-1', owner: WALLET }),
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

  test('a row that is not this organization, or not a launch, is a plain 404', async () => {
    expect((await call('GET', '/api/launch/srv00000002')).status).toBe(404);
    expect((await call('GET', '/api/launch/srv00000001', TEST_STRANGER)).status).toBe(404);
  });

  test('an unknown path under the surface is a 404, and a write to a read route a 405', async () => {
    expect((await call('GET', '/api/launch/srv00000001/nope')).status).toBe(404);
    expect((await call('POST', '/api/launch/srv00000001', TEST_OWNER, {})).status).toBe(405);
  });
});
