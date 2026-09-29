import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ApiError } from '@metro-labs/http/api-error';
import { SigningKeys } from '@metro-labs/http/workos-token';
import { handleDeletionApiRequest, resetDeletionState, type DeletionApiDeps } from '../src/deletion.js';
import { AwsError } from '../src/aws/ec2.js';
import type { ConfigResult } from '../src/launch-config.js';
import type { DeletionRow } from '../src/db/servers.js';
import { auth, testKeys, TEST_OWNER, TEST_STRANGER } from './identity-helper.ts';
import { BOX, BOX_DISK, HOST, OTHER, fakeAccount, fakeDeletionAws, instance, otherServer, type FakeAccount } from './deletion-fake.ts';

const CONFIG: ConfigResult = {
  ok: true,
  config: {
    credentials: { accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'secret' },
    tailnet: 'tail17c4f8.ts.net',
    authKey: 'tskey-auth-kABCDEF1CNTRL-abcdefghijklmnop',
  },
};
const LAUNCHED = 'srv00000001';
const HAND_ADDED = 'srv00000002';
const ROWS: Record<string, DeletionRow> = {
  [LAUNCHED]: { id: LAUNCHED, host: HOST, name: 'throwaway-47', instanceId: BOX, region: 'us-east-1' },
  [HAND_ADDED]: { id: HAND_ADDED, host: 'metro-6vfdky.tail17c4f8.ts.net', name: 'Tony', instanceId: null, region: null },
};

let config: ConfigResult = CONFIG;
let account: FakeAccount = fakeAccount();
let removed: string[] = [];
let busy = false;

const deps: DeletionApiDeps = {
  config: () => config,
  lookup: (owner, id) => {
    const row = ROWS[id];
    return owner === TEST_OWNER && row !== undefined ? Promise.resolve(row) : Promise.reject(new ApiError('no such server', 404));
  },
  remove: (owner, id) => {
    removed.push(`${owner} ${id}`);
    return Promise.resolve({ id, host: HOST });
  },
  resizing: () => busy,
  aws: fakeDeletionAws(account),
  keys: new SigningKeys('http://127.0.0.1:1/nowhere'),
};

let server: Server;
let base = '';

beforeAll(async () => {
  deps.keys = await testKeys();
  server = createServer((req, res) => {
    if (handleDeletionApiRequest(req, res, deps)) return;
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
  account = fakeAccount();
  deps.aws = fakeDeletionAws(account);
  removed = [];
  busy = false;
  resetDeletionState();
});

const call = async (method: string, path: string, body?: unknown, role: 'admin' | 'member' = 'admin', who = TEST_OWNER): Promise<Response> =>
  fetch(`${base}${path}`, {
    method,
    headers: { authorization: await auth(who, role), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const pathOf = (id = LAUNCHED): string => `/api/servers/${id}/deletion`;
const CONFIRM = { name: 'throwaway-47', instanceId: BOX, volumeIds: [BOX_DISK] };
const writes = (): string[] => account.calls.filter((c) => !c.startsWith('Describe'));
const errorOf = async (res: Response): Promise<string> => ((await res.json()) as { error: string }).error;

describe('what the dialog shows', () => {
  test('an unsigned request is refused', async () => {
    expect((await fetch(`${base}${pathOf()}`)).status).toBe(401);
  });

  test('the instance id, each disk id with its size, and never a key', async () => {
    const res = await call('GET', pathOf(), undefined, 'member');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      deletable: true,
      name: 'throwaway-47',
      host: HOST,
      node: 'metro-thrw01',
      region: 'us-east-1',
      instanceId: BOX,
      state: 'running',
      type: 't4g.medium',
      volumes: [{ volumeId: BOX_DISK, sizeGib: 8 }],
    });
    expect(account.calls).toEqual([`DescribeInstances us-east-1 ${BOX}`, `DescribeVolumes us-east-1 ${BOX_DISK}`]);
  });

  test('a server Metro did not launch, or a deployment without AWS, deletes nothing', async () => {
    expect(await (await call('GET', pathOf(HAND_ADDED))).json()).toEqual({ deletable: false, reason: expect.stringContaining('did not launch this server') as unknown as string });
    config = { ok: false, missing: ['METRO_AWS_ACCESS_KEY_ID'] };
    expect(await (await call('GET', pathOf())).json()).toEqual({ deletable: false, reason: expect.stringContaining('no AWS account') as unknown as string });
    expect(account.calls).toEqual([]);
  });
});

describe('deleting', () => {
  test('terminates the exact instance, lets its disk go with it, then removes only its row', async () => {
    const res = await call('POST', pathOf(), CONFIRM);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true, name: 'throwaway-47', terminated: true, instanceId: BOX, volumeIds: [BOX_DISK] });
    expect(writes()).toEqual([`TerminateInstances us-east-1 ${BOX}`]);
    expect(removed).toEqual([`${TEST_OWNER} ${LAUNCHED}`]);
    expect(account.instances.find((i) => i.instanceId === OTHER)?.state).toBe('running');
  });

  test('another organization cannot even see the server', async () => {
    expect((await call('GET', pathOf(), undefined, 'admin', TEST_STRANGER)).status).toBe(404);
    expect((await call('POST', pathOf(), CONFIRM, 'admin', TEST_STRANGER)).status).toBe(404);
    expect(account.calls).toEqual([]);
    expect(removed).toEqual([]);
  });

  test('a member who is not an admin is refused', async () => {
    const res = await call('POST', pathOf(), CONFIRM, 'member');
    expect(res.status).toBe(403);
    expect(account.calls).toEqual([]);
    expect(removed).toEqual([]);
  });

  test('the wrong name, or no ids, is refused before AWS is asked', async () => {
    expect(await errorOf(await call('POST', pathOf(), { ...CONFIRM, name: 'Lisa' }))).toBe('type the name of the server, throwaway-47, to delete it');
    expect((await call('POST', pathOf(), { name: 'throwaway-47' })).status).toBe(400);
    expect((await call('POST', pathOf(HAND_ADDED), { ...CONFIRM, name: 'Tony' })).status).toBe(400);
    expect(account.calls).toEqual([]);
    expect(removed).toEqual([]);
  });

  test('an instance tagged for another server is refused and its row stays', async () => {
    account.instances = [instance({ tags: { metro: 'metro-fa79qt' } }), otherServer()];
    const res = await call('POST', pathOf(), CONFIRM);
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toContain('is tagged metro=metro-fa79qt');
    expect(writes()).toEqual([]);
    expect(removed).toEqual([]);
  });

  test('ids that changed since the dialog opened are refused', async () => {
    const res = await call('POST', pathOf(), { ...CONFIRM, volumeIds: [] });
    expect(res.status).toBe(409);
    expect(writes()).toEqual([]);
    expect(removed).toEqual([]);
  });

  test('a server that is changing size is not deleted', async () => {
    busy = true;
    expect((await call('POST', pathOf(), CONFIRM)).status).toBe(409);
    expect(writes()).toEqual([]);
    expect(removed).toEqual([]);
  });

  test('a key without the right to look at disks says which permission is missing, and the row stays', async () => {
    account.refuse = new AwsError('UnauthorizedOperation', 'You are not authorized to perform this operation.', 'ec2:DescribeVolumes');
    const res = await call('POST', pathOf(), CONFIRM);
    expect(res.status).toBe(502);
    expect(await errorOf(res)).toBe("Metro's AWS key may not call ec2:DescribeVolumes. Add it to the policy of the IAM user metro.");
    expect(writes()).toEqual([]);
    expect(removed).toEqual([]);
  });

  test('a server AWS already terminated only leaves the list', async () => {
    account.instances = [instance({ state: 'terminated', disks: [] }), otherServer()];
    const res = await call('POST', pathOf(), { ...CONFIRM, volumeIds: [] });
    expect(await res.json()).toMatchObject({ deleted: true, terminated: false });
    expect(writes()).toEqual([]);
    expect(removed).toEqual([`${TEST_OWNER} ${LAUNCHED}`]);
  });

  test('an unknown method is a 405', async () => {
    expect((await call('DELETE', pathOf())).status).toBe(405);
  });
});
