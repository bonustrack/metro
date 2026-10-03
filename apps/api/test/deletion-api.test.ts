import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { log } from '@metro-labs/core/log';
import { ApiError } from '@metro-labs/http/api-error';
import { SigningKeys } from '@metro-labs/http/workos-token';
import { handleDeletionApiRequest, resetDeletionState, type DeletionApiDeps } from '../src/deletion.js';
import { AwsError } from '../src/aws/ec2.js';
import type { ConfigResult } from '../src/launch-config.js';
import type { DeletionRow } from '../src/db/servers.js';
import { auth, testKeys, TEST_OWNER, TEST_STRANGER } from './identity-helper.ts';
import { BOX, BOX_DISK, HOST, OTHER, fakeAccount, fakeDeletionAws, instance, otherServer, type FakeAccount } from './deletion-fake.ts';
import { CHANGED_SINCE_DIALOG, ENTRY_ONLY, LONG_AGO, STILL_REFUSED, confirmOf } from './deletion-cases.ts';

const CONFIG: ConfigResult = {
  ok: true,
  config: {
    credentials: { accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'secret' },
    role: null,
    tailnet: 'tail17c4f8.ts.net',
    tailscale: null,
  },
};
const LAUNCHED = 'srv00000001';
const HAND_ADDED = 'srv00000002';
const launched = (): DeletionRow => ({ id: LAUNCHED, owner: TEST_OWNER, host: HOST, name: 'throwaway-47', addedAt: LONG_AGO, instanceId: BOX, region: 'us-east-1', account: null });
const handAdded = (): DeletionRow => ({ id: HAND_ADDED, owner: TEST_OWNER, host: 'metro-6vfdky.tail17c4f8.ts.net', name: 'Tony', addedAt: LONG_AGO, instanceId: null, region: null, account: null });

let rows: Record<string, DeletionRow> = {};
let config: ConfigResult = CONFIG;
let account: FakeAccount = fakeAccount();
let removed: string[] = [];
let busy = false;
let hold: Promise<void> | null = null;

const deps: DeletionApiDeps = {
  config: () => config,
  lookup: (owner, id) => {
    const row = rows[id];
    return owner === TEST_OWNER && row !== undefined ? Promise.resolve(row) : Promise.reject(new ApiError('no such server', 404));
  },
  remove: async (owner, id) => {
    if (hold !== null) await hold;
    removed.push(`${owner} ${id}`);
    return { id, host: HOST };
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
  rows = { [LAUNCHED]: launched(), [HAND_ADDED]: handAdded() };
  config = CONFIG;
  account = fakeAccount();
  deps.aws = fakeDeletionAws(account);
  removed = [];
  busy = false;
  hold = null;
  resetDeletionState();
});

const call = async (method: string, path: string, body?: unknown, role: 'admin' | 'member' = 'admin', who = TEST_OWNER): Promise<Response> =>
  fetch(`${base}${path}`, {
    method,
    headers: { authorization: await auth(who, role), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const pathOf = (id = LAUNCHED): string => `/api/servers/${id}/deletion`;
const CONFIRM = { name: 'throwaway-47', instanceId: BOX, state: 'running', volumeIds: [BOX_DISK] };
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
      entryOnly: false,
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

  test('a deployment without AWS deletes nothing', async () => {
    config = { ok: false, missing: ['METRO_AWS_ACCESS_KEY_ID'] };
    expect(await (await call('GET', pathOf())).json()).toEqual({ deletable: false, reason: expect.stringContaining('no AWS account') as unknown as string });
    expect((await call('POST', pathOf(), CONFIRM)).status).toBe(400);
    expect(account.calls).toEqual([]);
    expect(removed).toEqual([]);
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
    expect(await errorOf(await call('POST', pathOf(), { ...CONFIRM, state: undefined }))).toBe('send the server id, its state and the disk ids the dialog showed');
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

  test('a second delete while the first is still removing the row is refused', async () => {
    let release = (): void => undefined;
    hold = new Promise((resolve) => {
      release = resolve;
    });
    const first = call('POST', pathOf(), CONFIRM);
    for (let i = 0; i < 50 && writes().length === 0; i += 1) await new Promise((r) => setTimeout(r, 2));
    expect((await call('POST', pathOf(), CONFIRM)).status).toBe(409);
    release();
    expect((await first).status).toBe(200);
    expect(writes()).toEqual([`TerminateInstances us-east-1 ${BOX}`]);
    expect(removed).toEqual([`${TEST_OWNER} ${LAUNCHED}`]);
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
    expect(res.status).toBe(503);
    expect(await errorOf(res)).toBe("Metro may not call ec2:DescribeVolumes in this AWS account. Add it to the policy Metro uses there.");
    expect(writes()).toEqual([]);
    expect(removed).toEqual([]);
  });

  test('an unknown method is a 405', async () => {
    expect((await call('DELETE', pathOf())).status).toBe(405);
  });
});

describe('a server that is not on AWS: only its entry goes', () => {
  for (const c of ENTRY_ONLY)
    test(`${c.when}: the dialog says so, and the confirm writes nothing to AWS`, async () => {
      c.aws(account);
      const view = await (await call('GET', pathOf())).json();
      expect(view).toMatchObject({ deletable: true, entryOnly: true, instanceId: BOX, state: c.state, volumes: [] });
      const info = spyOn(log, 'info');
      try {
        const res = await call('POST', pathOf(), confirmOf(view));
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ deleted: true, name: 'throwaway-47', terminated: false, instanceId: BOX, volumeIds: [] });
        const who = { by: 'user_01ABC', owner: TEST_OWNER, agent: LAUNCHED, host: HOST };
        expect(info).toHaveBeenCalledWith({ ...who, instanceId: BOX, state: c.state }, 'deletion: entry only, nothing is deleted in AWS');
      } finally {
        info.mockRestore();
      }
      expect(writes()).toEqual([]);
      expect(removed).toEqual([`${TEST_OWNER} ${LAUNCHED}`]);
    });

  test('a row with no instance id is removed without asking AWS, even on a deployment without AWS', async () => {
    config = { ok: false, missing: ['METRO_AWS_ACCESS_KEY_ID'] };
    const view = await (await call('GET', pathOf(HAND_ADDED))).json();
    expect(view).toMatchObject({ deletable: true, entryOnly: true, name: 'Tony', instanceId: '', state: 'not-launched', volumes: [] });
    expect((await call('POST', pathOf(HAND_ADDED), confirmOf(view))).status).toBe(200);
    expect(account.calls).toEqual([]);
    expect(removed).toEqual([`${TEST_OWNER} ${HAND_ADDED}`]);
  });

  for (const r of STILL_REFUSED)
    test(`${r.when}: refused, nothing written, the row stays`, async () => {
      if (r.addedAt !== undefined) rows[LAUNCHED] = { ...launched(), addedAt: r.addedAt };
      r.aws(account);
      const view = await call('GET', pathOf());
      expect(view.status).toBe(r.status);
      expect(await errorOf(view)).toContain(r.error);
      for (const body of [CONFIRM, { ...CONFIRM, state: 'not-found', volumeIds: [] }]) {
        const res = await call('POST', pathOf(), body);
        expect(res.status).toBe(r.status);
        expect(await errorOf(res)).toContain(r.error);
      }
      expect(writes()).toEqual([]);
      expect(removed).toEqual([]);
    });

  for (const c of CHANGED_SINCE_DIALOG)
    test(`${c.when} between the dialog and the confirm: refused`, async () => {
      c.before(account);
      const view = await (await call('GET', pathOf())).json();
      c.after(account);
      const res = await call('POST', pathOf(), confirmOf(view));
      expect(res.status).toBe(409);
      expect(await errorOf(res)).toContain('changed since the dialog opened');
      expect(writes()).toEqual([]);
      expect(removed).toEqual([]);
    });
});
