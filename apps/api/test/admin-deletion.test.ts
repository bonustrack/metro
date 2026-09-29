import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { log } from '@metro-labs/core/log';
import { ApiError } from '@metro-labs/http/api-error';
import { SigningKeys } from '@metro-labs/http/workos-token';
import { handleAdminApiRequest, type AdminApiDeps } from '../src/admin.ts';
import { readWorkosConfig } from '../src/auth/workos.ts';
import { resetDeletionState } from '../src/deletion.ts';
import type { ConfigResult } from '../src/launch-config.ts';
import type { DeletionRow } from '../src/db/servers.ts';
import { fakeWorkos, type FakeWorkos } from './workos-fake.ts';
import { memorySlugs } from './slug-fake.ts';
import { memoryUsers } from './users-fake.ts';
import { sessionClaims } from '../../../packages/http/test/workos-fixture.ts';
import { BOX, BOX_DISK, HOST, OTHER, OTHER_DISK, fakeAccount, fakeDeletionAws, instance, otherDisk, otherServer, volume, type FakeAccount } from './deletion-fake.ts';
import { CHANGED_SINCE_DIALOG, ENTRY_ONLY, LONG_AGO, STILL_REFUSED, confirmOf } from './deletion-cases.ts';

const OPERATOR_ORG = 'org_01STAGELABS00000';
const CLIENT_ORG = 'org_01CLIENT00000000';
const OPERATOR = 'user_01ABC';
const CLIENT_ADMIN = 'user_02BOB';
const LAUNCHED = 'srv00000001';
const HAND_ADDED = 'srv00000002';
const CONFIG: ConfigResult = {
  ok: true,
  config: {
    credentials: { accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'secret' },
    tailnet: 'tail17c4f8.ts.net',
    authKey: 'tskey-auth-kABCDEF1CNTRL-abcdefghijklmnop',
  },
};
const launched = (): DeletionRow => ({ id: LAUNCHED, owner: CLIENT_ORG, host: HOST, name: 'throwaway-50', addedAt: LONG_AGO, instanceId: BOX, region: 'us-east-1' });
const handAdded = (): DeletionRow => ({ id: HAND_ADDED, owner: CLIENT_ORG, host: 'metro-6vfdky.tail17c4f8.ts.net', name: 'Tony', addedAt: LONG_AGO, instanceId: null, region: null });

let workos: FakeWorkos;
let server: Server;
let base = '';
let deps: AdminApiDeps;
let rows: Record<string, DeletionRow> = {};
let config: ConfigResult = CONFIG;
let account: FakeAccount = fakeAccount();
let lookups: string[] = [];
let removed: string[] = [];
let busy = false;
let hold: Promise<void> | null = null;

beforeAll(async () => {
  workos = await fakeWorkos();
  workos.organizations.push(OPERATOR_ORG, CLIENT_ORG);
  const env = { WORKOS_API_KEY: 'sk_test_fake', WORKOS_CLIENT_ID: 'client_test', WORKOS_API_BASE: workos.base };
  deps = {
    config: () => readWorkosConfig(env),
    keys: new SigningKeys(workos.issuer.url),
    slugs: memorySlugs(),
    users: memoryUsers(),
    agents: () => Promise.resolve([]),
    deletion: {
      config: () => config,
      lookup: (id) => {
        lookups.push(id);
        const row = rows[id];
        return row === undefined ? Promise.reject(new ApiError('no such server', 404)) : Promise.resolve(row);
      },
      remove: async (owner, id) => {
        if (hold !== null) await hold;
        removed.push(`${owner} ${id}`);
        return { id, host: HOST };
      },
      resizing: () => busy,
      aws: fakeDeletionAws(account),
    },
    metrics: {
      config: () => config,
      aws: {
        list: () => Promise.reject(new Error('not used here')),
        data: () => Promise.reject(new Error('not used here')),
        assume: () => Promise.reject(new Error('not used here')),
        describe: () => Promise.reject(new Error('not used here')),
        associate: () => Promise.reject(new Error('not used here')),
      },
      now: () => Date.now(),
      save: () => Promise.reject(new Error('not used here')),
    },
  };
  await deps.users.noteLogin({ id: OPERATOR, email: 'admin@stage.box', name: 'Stage Labs', picture: null, createdAt: '2026-09-01T10:00:00.000Z' }, '2026-09-29T10:00:00.000Z');
  await deps.users.noteLogin({ id: CLIENT_ADMIN, email: 'bob@client.example', name: 'Bob', picture: null, createdAt: '2026-09-02T10:00:00.000Z' }, '2026-09-29T10:00:00.000Z');
  await deps.users.setStatus(CLIENT_ADMIN, 'approved');
  server = createServer((req, res) => {
    if (!handleAdminApiRequest(req, res, deps)) res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

afterAll(async () => {
  server.close();
  await workos.close();
});

beforeEach(() => {
  rows = { [LAUNCHED]: launched(), [HAND_ADDED]: handAdded() };
  config = CONFIG;
  account = fakeAccount();
  deps.deletion.aws = fakeDeletionAws(account);
  lookups = [];
  removed = [];
  busy = false;
  hold = null;
  resetDeletionState();
});

const token = (sub: string, org: string, role: 'admin' | 'member'): string => workos.issuer.mint(sessionClaims({ sub, org_id: org, role }));
const asOperator = (): string => token(OPERATOR, OPERATOR_ORG, 'member');

const call = (method: string, id: string, bearer?: string, body?: unknown): Promise<Response> =>
  fetch(`${base}/api/admin/servers/${id}/deletion`, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(bearer === undefined ? {} : { authorization: `Bearer ${bearer}` }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const CONFIRM = { name: 'throwaway-50', instanceId: BOX, state: 'running', volumeIds: [BOX_DISK] };
const writes = (): string[] => account.calls.filter((c) => !c.startsWith('Describe'));
const terminated = (): string[] => account.calls.filter((c) => c.startsWith('TerminateInstances'));
const errorOf = async (res: Response): Promise<string> => ((await res.json()) as { error: string }).error;

describe('only the platform admin may use it', () => {
  test('no token is 401, and nothing is looked up', async () => {
    expect((await call('GET', LAUNCHED)).status).toBe(401);
    expect((await call('POST', LAUNCHED, undefined, CONFIRM)).status).toBe(401);
    expect(lookups).toEqual([]);
  });

  test('an admin, or a member, of the organization that owns the server is refused', async () => {
    for (const role of ['admin', 'member'] as const) {
      const bearer = token(CLIENT_ADMIN, CLIENT_ORG, role);
      expect((await call('GET', LAUNCHED, bearer)).status).toBe(403);
      const res = await call('POST', LAUNCHED, bearer, CONFIRM);
      expect(res.status).toBe(403);
      expect(await errorOf(res)).toBe('this page is for the Metro operator');
    }
    expect(lookups).toEqual([]);
    expect(account.calls).toEqual([]);
    expect(removed).toEqual([]);
  });

  test('a trailing slash, a query string or another method does not get around the check', async () => {
    const bearer = token(CLIENT_ADMIN, CLIENT_ORG, 'admin');
    const headers = { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' };
    for (const suffix of ['/', '?as=operator'])
      expect((await fetch(`${base}/api/admin/servers/${LAUNCHED}/deletion${suffix}`, { method: 'POST', headers, body: JSON.stringify(CONFIRM) })).status).toBe(403);
    expect((await call('PUT', LAUNCHED, bearer, CONFIRM)).status).toBe(403);
    expect(lookups).toEqual([]);
    expect(account.calls).toEqual([]);
    expect(removed).toEqual([]);
  });
});

describe('the platform admin', () => {
  test('sees whose server it is, its instance and each disk, while signed in to another organization', async () => {
    const res = await call('GET', LAUNCHED, asOperator());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      deletable: true,
      entryOnly: false,
      name: 'throwaway-50',
      host: HOST,
      node: 'metro-thrw01',
      region: 'us-east-1',
      instanceId: BOX,
      state: 'running',
      type: 't4g.medium',
      volumes: [{ volumeId: BOX_DISK, sizeGib: 8 }],
      owner: CLIENT_ORG,
      organizationName: 'Stage Labs',
    });
    expect(account.calls).toEqual([`DescribeInstances us-east-1 ${BOX}`, `DescribeVolumes us-east-1 ${BOX_DISK}`]);
  });

  test('deletes a server of another organization: only its instance id is terminated, and only its row goes, logged with who and for whom', async () => {
    const info = spyOn(log, 'info');
    try {
      const res = await call('POST', LAUNCHED, asOperator(), CONFIRM);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ deleted: true, name: 'throwaway-50', terminated: true, instanceId: BOX, volumeIds: [BOX_DISK] });
      const who = { by: OPERATOR, owner: CLIENT_ORG, agent: LAUNCHED, host: HOST };
      expect(info).toHaveBeenCalledWith(who, 'admin: deleting a server for its organization');
      expect(info).toHaveBeenCalledWith({ ...who, instanceId: BOX, volumeIds: [BOX_DISK], terminated: true }, 'admin: server deleted for its organization');
    } finally {
      info.mockRestore();
    }
    expect(writes()).toEqual([`TerminateInstances us-east-1 ${BOX}`]);
    expect(removed).toEqual([`${CLIENT_ORG} ${LAUNCHED}`]);
    expect(account.instances.find((i) => i.instanceId === OTHER)?.state).toBe('running');
    expect(account.volumes.map((v) => v.volumeId)).toEqual([OTHER_DISK]);
  });

  test('a disk AWS would keep is set to go with the server on its own device first, then only that one instance is terminated', async () => {
    account.instances = [instance({ disks: [{ device: '/dev/sda1', volumeId: BOX_DISK, deleteOnTermination: false }] }), otherServer()];
    expect((await call('POST', LAUNCHED, asOperator(), CONFIRM)).status).toBe(200);
    expect(writes()).toEqual([`ModifyInstanceAttribute ${BOX} /dev/sda1 DeleteOnTermination=true`, `TerminateInstances us-east-1 ${BOX}`]);
    expect(terminated()).toEqual([`TerminateInstances us-east-1 ${BOX}`]);
  });

  test('an id no organization lists is a 404', async () => {
    expect((await call('GET', 'srv00000009', asOperator())).status).toBe(404);
    expect(account.calls).toEqual([]);
  });

  test('an unknown method is a 405', async () => {
    expect((await call('DELETE', LAUNCHED, asOperator())).status).toBe(405);
    expect(lookups).toEqual([]);
  });
});

interface Refusal {
  when: string;
  status: number;
  error: string;
  body?: Record<string, unknown>;
  id?: string;
  setup?: () => void;
}

const REFUSALS: Refusal[] = [
  { when: 'the typed name is not the server name', status: 400, error: 'type the name of the server, throwaway-50, to delete it', body: { ...CONFIRM, name: 'Tony' } },
  { when: 'the dialog ids are missing', status: 400, error: 'send the server id, its state and the disk ids the dialog showed', body: { name: 'throwaway-50' } },
  { when: 'the dialog state is missing', status: 400, error: 'send the server id, its state and the disk ids the dialog showed', body: { ...CONFIRM, state: '' } },
  { when: 'a row with no instance id is sent the ids of a server', status: 409, error: 'changed since the dialog opened', id: HAND_ADDED, body: { ...CONFIRM, name: 'Tony' } },
  { when: 'the deployment has no AWS account', status: 400, error: 'no AWS account', setup: () => (config = { ok: false, missing: ['METRO_AWS_ACCESS_KEY_ID'] }) },
  { when: 'the row address is not one Metro gives', status: 409, error: 'is not an address Metro gives', setup: () => (rows[LAUNCHED] = { ...launched(), host: 'tony.example.com' }) },
  { when: 'the instance carries another node tag', status: 409, error: 'is tagged metro=metro-fa79qt', setup: () => (account.instances = [instance({ tags: { metro: 'metro-fa79qt' } }), otherServer()]) },
  { when: 'the instance carries no metro tag', status: 409, error: 'is tagged metro=(none)', setup: () => (account.instances = [instance({ tags: {} }), otherServer()]) },
  { when: 'the instance is tagged for another agent', status: 409, error: 'tagged for another agent, srv00000009', setup: () => (account.instances = [instance({ tags: { metro: 'metro-thrw01', 'metro:agent': 'srv00000009' } }), otherServer()]) },
  { when: 'AWS answers with another instance', status: 409, error: `AWS answered with ${OTHER}`, setup: () => (account.answerFor = OTHER) },
  { when: 'a disk is also attached to another server', status: 409, error: `attached to ${BOX}, ${OTHER}`, setup: () => (account.volumes = [volume({ attachedTo: [BOX, OTHER] }), otherDisk()]) },
  { when: 'a disk is tagged for another server', status: 409, error: `The disk ${BOX_DISK} is tagged metro=metro-fa79qt`, setup: () => (account.volumes = [volume({ tags: { metro: 'metro-fa79qt' } }), otherDisk()]) },
  { when: 'AWS describes other disks than the ones attached', status: 409, error: 'AWS described the disks', setup: () => (account.volumes = [otherDisk()]) },
  { when: 'the ids differ from what the dialog showed', status: 409, error: 'changed since the dialog opened', body: { ...CONFIRM, volumeIds: [BOX_DISK, OTHER_DISK] } },
  { when: 'the instance id differs from what the dialog showed', status: 409, error: 'changed since the dialog opened', body: { ...CONFIRM, instanceId: OTHER } },
  { when: 'the state differs from what the dialog showed', status: 409, error: 'changed since the dialog opened', body: { ...CONFIRM, state: 'not-found', volumeIds: [] } },
  { when: 'the server is changing size', status: 409, error: 'this server is changing size', setup: () => (busy = true) },
  {
    when: 'AWS still keeps the disk after it was set to go with the server',
    status: 409,
    error: `AWS would still keep the disk ${BOX_DISK}`,
    setup: () => {
      account.keepDisks = true;
      account.instances = [instance({ disks: [{ device: '/dev/sda1', volumeId: BOX_DISK, deleteOnTermination: false }] }), otherServer()];
    },
  },
];

describe('every #47 refusal still holds on the admin path: nothing is terminated and the row stays', () => {
  for (const r of REFUSALS)
    test(r.when, async () => {
      r.setup?.();
      const res = await call('POST', r.id ?? LAUNCHED, asOperator(), r.body ?? CONFIRM);
      expect(res.status).toBe(r.status);
      expect(await errorOf(res)).toContain(r.error);
      expect(terminated()).toEqual([]);
      expect(account.instances.map((i) => i.state)).toEqual(account.instances.map(() => 'running'));
      expect(removed).toEqual([]);
    });

  test('a second delete while the first is still removing the row is refused, and the instance is terminated once', async () => {
    let release = (): void => undefined;
    hold = new Promise((resolve) => {
      release = resolve;
    });
    const first = call('POST', LAUNCHED, asOperator(), CONFIRM);
    for (let i = 0; i < 50 && writes().length === 0; i += 1) await new Promise((r) => setTimeout(r, 2));
    const second = await call('POST', LAUNCHED, asOperator(), CONFIRM);
    expect(second.status).toBe(409);
    expect(await errorOf(second)).toBe('this server is already being deleted');
    release();
    expect((await first).status).toBe(200);
    expect(terminated()).toEqual([`TerminateInstances us-east-1 ${BOX}`]);
    expect(removed).toEqual([`${CLIENT_ORG} ${LAUNCHED}`]);
  });
});

describe('a server that is not on AWS: the platform admin removes only its entry', () => {
  for (const c of ENTRY_ONLY)
    test(`${c.when}: the dialog says so, and the confirm writes nothing to AWS, logged as entry only`, async () => {
      c.aws(account);
      const view = await (await call('GET', LAUNCHED, asOperator())).json();
      expect(view).toMatchObject({ deletable: true, entryOnly: true, instanceId: BOX, state: c.state, volumes: [], owner: CLIENT_ORG });
      const info = spyOn(log, 'info');
      try {
        const res = await call('POST', LAUNCHED, asOperator(), confirmOf(view));
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ deleted: true, name: 'throwaway-50', terminated: false, instanceId: BOX, volumeIds: [] });
        const who = { by: OPERATOR, owner: CLIENT_ORG, agent: LAUNCHED, host: HOST };
        expect(info).toHaveBeenCalledWith({ ...who, instanceId: BOX, state: c.state }, 'deletion: entry only, nothing is deleted in AWS');
        expect(info).toHaveBeenCalledWith({ ...who, instanceId: BOX, volumeIds: [], terminated: false }, 'admin: agent entry removed for its organization, entry only');
      } finally {
        info.mockRestore();
      }
      expect(writes()).toEqual([]);
      expect(removed).toEqual([`${CLIENT_ORG} ${LAUNCHED}`]);
    });

  test('a row with no instance id is removed without asking AWS', async () => {
    const view = await (await call('GET', HAND_ADDED, asOperator())).json();
    expect(view).toMatchObject({ deletable: true, entryOnly: true, name: 'Tony', instanceId: '', state: 'not-launched', owner: CLIENT_ORG });
    expect((await call('POST', HAND_ADDED, asOperator(), confirmOf(view))).status).toBe(200);
    expect(account.calls).toEqual([]);
    expect(removed).toEqual([`${CLIENT_ORG} ${HAND_ADDED}`]);
  });

  for (const r of STILL_REFUSED)
    test(`${r.when}: refused, nothing written, the row stays`, async () => {
      if (r.addedAt !== undefined) rows[LAUNCHED] = { ...launched(), addedAt: r.addedAt };
      r.aws(account);
      const view = await call('GET', LAUNCHED, asOperator());
      expect(view.status).toBe(r.status);
      expect(await errorOf(view)).toContain(r.error);
      for (const body of [CONFIRM, { ...CONFIRM, state: 'not-found', volumeIds: [] }]) {
        const res = await call('POST', LAUNCHED, asOperator(), body);
        expect(res.status).toBe(r.status);
        expect(await errorOf(res)).toContain(r.error);
      }
      expect(writes()).toEqual([]);
      expect(removed).toEqual([]);
    });

  for (const c of CHANGED_SINCE_DIALOG)
    test(`${c.when} between the dialog and the confirm: refused`, async () => {
      c.before(account);
      const view = await (await call('GET', LAUNCHED, asOperator())).json();
      c.after(account);
      const res = await call('POST', LAUNCHED, asOperator(), confirmOf(view));
      expect(res.status).toBe(409);
      expect(await errorOf(res)).toContain('changed since the dialog opened');
      expect(writes()).toEqual([]);
      expect(removed).toEqual([]);
    });
});
