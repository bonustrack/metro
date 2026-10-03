import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ApiError } from '@metro-labs/http/api-error';
import { SigningKeys } from '@metro-labs/http/workos-token';
import { handleSizeApiRequest, resetSizeState, type SizeApiDeps } from '../src/size.js';
import { resetSizes } from '../src/aws/sizes.js';
import { AwsError } from '../src/aws/ec2.js';
import type { ConfigResult } from '../src/launch-config.js';
import { auth, testKeys, TEST_OWNER, TEST_STRANGER } from './identity-helper.ts';
import { fakeAws, fakeBox, type FakeBox } from './ec2-fake.ts';

const CONFIG: ConfigResult = {
  ok: true,
  config: {
    credentials: { accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'secret' },
    tailnet: 'tail17c4f8.ts.net',
    tailscale: null,
  },
};
const LAUNCHED = 'srv00000001';
const HAND_ADDED = 'srv00000002';
const SPECS: Record<string, [number, number]> = { 't4g.medium': [2, 4096], 't4g.large': [2, 8192], 't4g.xlarge': [4, 16384] };

let config: ConfigResult = CONFIG;
let box: FakeBox = fakeBox();
let hold: Promise<void> | null = null;
let diskGrowing = false;

const deps: SizeApiDeps = {
  config: () => config,
  lookup: (owner, id) => {
    if (owner !== TEST_OWNER) return Promise.reject(new ApiError('no such server', 404));
    if (id === LAUNCHED) return Promise.resolve({ instanceId: 'i-0abc', region: 'us-east-1' });
    if (id === HAND_ADDED) return Promise.resolve(null);
    return Promise.reject(new ApiError('no such server', 404));
  },
  aws: fakeAws(box),
  sizes: {
    types: (_c, _r, names) =>
      Promise.resolve(names.flatMap((type) => (SPECS[type] === undefined ? [] : [{ type, vcpus: SPECS[type][0], memoryMib: SPECS[type][1], architectures: ['arm64'] }]))),
    price: (_c, _r, type) => Promise.resolve(type === 't4g.medium' ? 0.0336 : 0.0672),
    now: () => 0,
  },
  growing: () => diskGrowing,
  keys: new SigningKeys('http://127.0.0.1:1/nowhere'),
};

let server: Server;
let base = '';

beforeAll(async () => {
  deps.keys = await testKeys();
  server = createServer((req, res) => {
    if (handleSizeApiRequest(req, res, deps)) return;
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
  box = fakeBox();
  hold = null;
  diskGrowing = false;
  const aws = fakeAws(box);
  deps.aws = {
    ...aws,
    stop: async (target) => {
      if (hold !== null) await hold;
      await aws.stop(target);
    },
  };
  resetSizeState();
  resetSizes();
});

const call = async (method: string, path: string, body?: unknown, role: 'admin' | 'member' = 'admin', who = TEST_OWNER): Promise<Response> =>
  fetch(`${base}${path}`, {
    method,
    headers: { authorization: await auth(who, role), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const sizePath = (id = LAUNCHED): string => `/api/servers/${id}/size`;
const settled = async (): Promise<void> => {
  for (let i = 0; i < 50; i += 1) await new Promise((r) => setTimeout(r, 1));
};

describe('reading a server size', () => {
  test('an unsigned request is refused', async () => {
    expect((await fetch(`${base}${sizePath()}`)).status).toBe(401);
  });

  test('a server of another organization is not found', async () => {
    expect((await call('GET', sizePath(), undefined, 'admin', TEST_STRANGER)).status).toBe(404);
    expect((await call('GET', sizePath('srv00000009'))).status).toBe(404);
  });

  test('a server Metro did not launch says why it cannot be resized', async () => {
    const body = (await (await call('GET', sizePath(HAND_ADDED))).json()) as { resizable: boolean; reason: string };
    expect(body.resizable).toBe(false);
    expect(body.reason).toContain('did not launch this server on AWS');
  });

  test('a deployment without AWS keys resizes nothing', async () => {
    config = { ok: false, missing: ['METRO_AWS_ACCESS_KEY_ID'] };
    const body = (await (await call('GET', sizePath())).json()) as { resizable: boolean; reason: string };
    expect(body).toEqual({ resizable: false, reason: expect.stringContaining('no AWS account') as unknown as string });
  });

  test('a launched server shows its state, size and the other sizes, and never a key', async () => {
    const res = await call('GET', sizePath(), undefined, 'member');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      resizable: true,
      region: 'us-east-1',
      instanceId: 'i-0abc',
      state: 'running',
      type: 't4g.medium',
      architecture: 'arm64',
      current: { type: 't4g.medium', vcpus: 2, memoryMib: 4096, hourlyUsd: 0.0336 },
      options: [
        { type: 't4g.large', vcpus: 2, memoryMib: 8192, hourlyUsd: 0.0672 },
        { type: 't4g.xlarge', vcpus: 4, memoryMib: 16384, hourlyUsd: 0.0672 },
      ],
      job: null,
    });
    expect(JSON.stringify(body)).not.toContain('AKIA');
  });

  test('an AWS refusal is a 503 that names the missing permission', async () => {
    deps.aws.describe = () => Promise.reject(new AwsError('UnauthorizedOperation', 'arn:aws:iam::123456789012:user/metro', 'ec2:DescribeInstances'));
    const res = await call('GET', sizePath());
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('ec2:DescribeInstances');
    expect(body.error).not.toContain('123456789012');
  });
});

describe('changing a server size', () => {
  test('needs the admin role', async () => {
    const res = await call('POST', sizePath(), { type: 't4g.large' }, 'member');
    expect(res.status).toBe(403);
    expect(box.calls).toEqual([]);
  });

  test('refuses a malformed type, a size not offered, and the size it already has', async () => {
    expect((await call('POST', sizePath(), { type: 'large please' })).status).toBe(400);
    expect((await call('POST', sizePath(), { type: 'm1.small' })).status).toBe(400);
    expect((await call('POST', sizePath(), { type: 't4g.medium' })).status).toBe(400);
    expect((await call('POST', sizePath(HAND_ADDED), { type: 't4g.large' })).status).toBe(400);
    expect(box.calls.filter((c) => c !== 'describe')).toEqual([]);
  });

  test('refuses while the disk of the box is growing', async () => {
    diskGrowing = true;
    const res = await call('POST', sizePath(), { type: 't4g.large' });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain('disk of this server is growing');
    expect(box.calls).toEqual([]);
  });

  test('refuses while AWS says the box is between states', async () => {
    box.state = 'pending';
    const res = await call('POST', sizePath(), { type: 't4g.large' });
    expect(res.status).toBe(409);
  });

  test('starts the job, refuses a second one meanwhile, and shows the result once done', async () => {
    let release = (): void => undefined;
    hold = new Promise<void>((r) => {
      release = r;
    });
    const res = await call('POST', sizePath(), { type: 't4g.large' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { job: { phase: string; from: string; to: string } }).job).toMatchObject({ phase: 'stopping', from: 't4g.medium', to: 't4g.large' });
    expect((await call('POST', sizePath(), { type: 't4g.xlarge' })).status).toBe(409);
    release();
    await settled();
    const after = (await (await call('GET', sizePath())).json()) as { state: string; type: string; job: { phase: string; error: string | null } };
    expect(after).toMatchObject({ state: 'running', type: 't4g.large', job: { phase: 'done', error: null } });
    expect(box.calls.filter((c) => c !== 'describe')).toEqual(['stop', 'setType t4g.large', 'start t4g.large']);
    box.clock += 2 * 60 * 60_000;
    expect(((await (await call('GET', sizePath())).json()) as { job: unknown }).job).toBeNull();
  });

  test('a stopped box can be started on its own size', async () => {
    box.state = 'stopped';
    expect((await call('POST', sizePath(), { type: 't4g.medium' })).status).toBe(200);
    await settled();
    expect(box.state).toBe('running');
    expect(box.calls.filter((c) => c !== 'describe')).toEqual(['start t4g.medium']);
  });

  test('another method is refused and a bad id is not found', async () => {
    expect((await call('DELETE', sizePath())).status).toBe(405);
    expect((await call('GET', '/api/servers/x/size')).status).toBe(404);
  });
});
