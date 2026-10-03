import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ApiError } from '@metro-labs/http/api-error';
import { SigningKeys } from '@metro-labs/http/workos-token';
import { growing, handleStorageApiRequest, resetStorageState, type StorageApiDeps } from '../src/storage.js';
import { AwsError } from '../src/aws/ec2.js';
import type { ConfigResult } from '../src/launch-config.js';
import type { DeletionRow } from '../src/db/servers.js';
import { auth, testKeys, TEST_OWNER, TEST_STRANGER } from './identity-helper.ts';
import { BOX, BOX_DISK, HOST, instance, volume } from './deletion-fake.ts';
import { fakeDisks, fakeGrowAws, modification, type FakeDisks } from './grow-fake.ts';

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
const ROWS: Record<string, DeletionRow> = {
  [LAUNCHED]: { id: LAUNCHED, owner: TEST_OWNER, host: HOST, name: 'throwaway', addedAt: '2026-09-01T00:00:00.000Z', instanceId: BOX, region: 'us-east-1' },
  [HAND_ADDED]: { id: HAND_ADDED, owner: TEST_OWNER, host: 'metro-6vfdky.tail17c4f8.ts.net', name: 'Tony', addedAt: '2026-09-01T00:00:00.000Z', instanceId: null, region: null },
};

let config: ConfigResult = CONFIG;
let disks: FakeDisks = fakeDisks();
let resizing = false;
let priced: string[] = [];

const deps: StorageApiDeps = {
  config: () => config,
  lookup: (owner, id) => {
    const row = ROWS[id];
    return owner === TEST_OWNER && row !== undefined ? Promise.resolve(row) : Promise.reject(new ApiError('no such server', 404));
  },
  aws: fakeGrowAws(disks),
  price: (_c, region, type) => {
    priced.push(`${region} ${type}`);
    return Promise.resolve(0.08);
  },
  resizing: () => resizing,
  keys: new SigningKeys('http://127.0.0.1:1/nowhere'),
};

let server: Server;
let base = '';

beforeAll(async () => {
  deps.keys = await testKeys();
  server = createServer((req, res) => {
    if (handleStorageApiRequest(req, res, deps)) return;
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
  disks = fakeDisks();
  deps.aws = fakeGrowAws(disks);
  resizing = false;
  priced = [];
  resetStorageState();
});

const call = async (method: string, path: string, body?: unknown, role: 'admin' | 'member' = 'admin', who = TEST_OWNER): Promise<Response> =>
  fetch(`${base}${path}`, {
    method,
    headers: { authorization: await auth(who, role), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const storagePath = (id = LAUNCHED): string => `/api/servers/${id}/storage`;
const writes = (): string[] => disks.calls.filter((c) => !c.startsWith('Describe'));
const settled = async (): Promise<void> => {
  for (let i = 0; i < 50; i += 1) await new Promise((r) => setTimeout(r, 1));
};

describe('reading the disk of a server', () => {
  test('an unsigned request is refused, and a server of another organization is not found', async () => {
    expect((await fetch(`${base}${storagePath()}`)).status).toBe(401);
    expect((await call('GET', storagePath(), undefined, 'admin', TEST_STRANGER)).status).toBe(404);
    expect((await call('GET', '/api/servers/x/storage')).status).toBe(404);
  });

  test('a server Metro did not launch, or a deployment without AWS, says why', async () => {
    expect(await (await call('GET', storagePath(HAND_ADDED))).json()).toEqual({ growable: false, reason: expect.stringContaining('did not launch this server') as unknown as string });
    config = { ok: false, missing: ['METRO_AWS_ACCESS_KEY_ID'] };
    expect(await (await call('GET', storagePath())).json()).toEqual({ growable: false, reason: expect.stringContaining('no AWS account') as unknown as string });
    expect(disks.calls).toEqual([]);
  });

  test('a launched server shows its root disk, the price and the bigger sizes, and never a key', async () => {
    const res = await call('GET', storagePath(), undefined, 'member');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      growable: true,
      region: 'us-east-1',
      instanceId: BOX,
      state: 'running',
      volumeId: BOX_DISK,
      sizeGib: 8,
      type: 'gp3',
      maxGib: 65_536,
      gbMonthUsd: 0.08,
      options: [16, 24, 32, 48, 64, 96, 128, 192, 256, 384, 512, 768, 1024, 1536, 2048],
      modification: null,
      job: null,
    });
    expect(JSON.stringify(body)).not.toContain('AKIA');
    await call('GET', storagePath());
    expect(priced).toEqual(['us-east-1 gp3']);
  });

  test('a box whose tags do not match is a 409 that names why', async () => {
    disks.instances = [instance({ tags: { metro: 'metro-other1' } })];
    const res = await call('GET', storagePath());
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain('tagged metro=metro-other1');
  });
});

describe('growing the disk of a server', () => {
  test('needs the admin role and a whole number of GiB', async () => {
    expect((await call('POST', storagePath(), { sizeGib: 32 }, 'member')).status).toBe(403);
    expect((await call('POST', storagePath(), { sizeGib: '32' })).status).toBe(400);
    expect((await call('POST', storagePath(), { sizeGib: 32.5 })).status).toBe(400);
    expect((await call('POST', storagePath(HAND_ADDED), { sizeGib: 32 })).status).toBe(400);
    expect(writes()).toEqual([]);
  });

  test('refuses a size that is not bigger or not offered', async () => {
    const smaller = await call('POST', storagePath(), { sizeGib: 8 });
    expect(smaller.status).toBe(400);
    expect(((await smaller.json()) as { error: string }).error).toContain('can only grow');
    expect((await call('POST', storagePath(), { sizeGib: 33 })).status).toBe(400);
    expect((await call('POST', storagePath(), { sizeGib: 4096 })).status).toBe(400);
    expect(writes()).toEqual([]);
  });

  test('refuses while AWS still applies the last change, while the server changes size, or between states', async () => {
    disks.modification = modification({ state: 'optimizing', progress: 40 });
    disks.next = [];
    expect((await call('POST', storagePath(), { sizeGib: 32 })).status).toBe(409);
    disks.modification = null;
    resizing = true;
    expect((await call('POST', storagePath(), { sizeGib: 32 })).status).toBe(409);
    resizing = false;
    disks.instances = [instance({ state: 'stopping' })];
    expect((await call('POST', storagePath(), { sizeGib: 32 })).status).toBe(409);
    expect(writes()).toEqual([]);
  });

  test('grows the disk, refuses a second change meanwhile, restarts the box once and shows the result', async () => {
    let release = (): void => undefined;
    disks.hold = new Promise<void>((r) => {
      release = r;
    });
    const res = await call('POST', storagePath(), { sizeGib: 32 });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { job: unknown }).job).toMatchObject({ from: 8, to: 32, restart: true, error: null });
    await settled();
    expect(growing('us-east-1', BOX)).toBe(true);
    expect((await call('POST', storagePath(), { sizeGib: 48 })).status).toBe(409);
    release();
    await settled();
    expect(growing('us-east-1', BOX)).toBe(false);
    const after = (await (await call('GET', storagePath())).json()) as { sizeGib: number; options: number[]; job: unknown };
    expect(after.sizeGib).toBe(32);
    expect(after.options[0]).toBe(48);
    expect(after.job).toMatchObject({ phase: 'done', error: null, to: 32 });
    expect(writes()).toEqual([`ModifyVolume ${BOX_DISK} 32`, `RebootInstances ${BOX}`]);
    disks.clock += 2 * 60 * 60_000;
    expect(((await (await call('GET', storagePath())).json()) as { job: unknown }).job).toBeNull();
  });

  test('tags a disk launched before volumes were tagged, then grows it', async () => {
    disks.volumes = [volume({ tags: {} })];
    expect((await call('POST', storagePath(), { sizeGib: 16 })).status).toBe(200);
    await settled();
    expect(writes()).toEqual([`CreateTags ${BOX_DISK} metro=metro-thrw01`, `ModifyVolume ${BOX_DISK} 16`, `RebootInstances ${BOX}`]);
  });

  test('a key that may not read disk changes is a 503 naming the permission', async () => {
    disks.refuse = { read: new AwsError('UnauthorizedOperation', 'You are not authorized to perform this operation.', 'ec2:DescribeVolumesModifications') };
    const res = await call('GET', storagePath());
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toBe("Metro's AWS key may not call ec2:DescribeVolumesModifications. Add it to the policy of the IAM user metro.");
  });

  test('an AWS refusal of ModifyVolume is a 503 naming the missing permission, and no job starts', async () => {
    disks.refuse = { grow: new AwsError('UnauthorizedOperation', 'arn:aws:iam::123456789012:user/metro', 'ec2:ModifyVolume') };
    const res = await call('POST', storagePath(), { sizeGib: 16 });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('ec2:ModifyVolume');
    expect(body.error).not.toContain('123456789012');
    expect(growing('us-east-1', BOX)).toBe(false);
    expect(((await (await call('GET', storagePath())).json()) as { job: unknown }).job).toBeNull();
  });

  test('another method is refused', async () => {
    expect((await call('DELETE', storagePath())).status).toBe(405);
  });
});
