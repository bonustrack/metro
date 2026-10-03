import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ApiError } from '@metro-labs/http/api-error';
import { SigningKeys } from '@metro-labs/http/workos-token';
import { handleAwsConnectionsRequest, resetConnectionsState, type AwsConnectionsDeps } from '../src/aws-connections.ts';
import { handleServerLinkRequest, type ServerLinkDeps } from '../src/server-link.ts';
import { createAccess } from '../src/aws/access.ts';
import { AwsError, keysOf, type AwsCredentials } from '../src/aws/ec2.ts';
import { templatesOf } from '../src/aws/templates.ts';
import type { InstanceFacts } from '../src/aws/teardown.ts';
import type { ConfigResult } from '../src/launch-config.ts';
import type { DeletionRow } from '../src/db/servers.ts';
import { auth, testKeys, TEST_OWNER, TEST_STRANGER } from './identity-helper.ts';
import { memoryAws, type MemoryAws } from './aws-store-fake.ts';

const METRO_ROLE = 'arn:aws:iam::787391402827:role/metro-api';
const ROLE = 'arn:aws:iam::111122223333:role/metro-access';
const HOUR = 3_600_000;
const READY: ConfigResult = { ok: true, config: { credentials: { accessKeyId: 'AKIAMETRO', secretAccessKey: 's' }, role: METRO_ROLE, tailnet: 'tail17c4f8.ts.net', tailscale: null } };
const BUCKET = 'https://metro-templates-787391402827.s3.us-east-1.amazonaws.com';
const ANDY = 'srv0000andy';
const OURS = 'srv00000own';
const HOSTS: Record<string, string> = { [ANDY]: 'metro-8m4meq.tail17c4f8.ts.net', [OURS]: 'metro-vutmn2.tail17c4f8.ts.net' };

let config: ConfigResult = READY;
let bucket = BUCKET;
let store: MemoryAws = memoryAws();
let calls: string[] = [];
let callerAccount = '111122223333';
let refuseAssume = false;
let instances: InstanceFacts[] = [];

const facts = (instanceId: string, tags: Record<string, string>): InstanceFacts => ({ instanceId, state: 'running', type: 't4g.medium', tags, rootDevice: '/dev/sda1', disks: [], profile: null });
const keyOf = async (credentials: AwsCredentials): Promise<string> => (await keysOf(credentials)).accessKeyId;

const access = createAccess({
  webIdentity: () => Promise.resolve({ accessKeyId: 'ASIAMETRO', secretAccessKey: 's', sessionToken: 't', expiresAt: HOUR }),
  assume: (_base, roleArn, externalId) => {
    calls.push(`assume ${roleArn} ${externalId}`);
    if (refuseAssume) return Promise.reject(new AwsError('AccessDenied', 'not authorized to perform sts:AssumeRole', 'sts:AssumeRole'));
    return Promise.resolve({ accessKeyId: 'ASIACONN', secretAccessKey: 's', sessionToken: 't', expiresAt: HOUR });
  },
  now: () => 0,
});

const awsDeps: AwsConnectionsDeps = {
  config: () => config,
  templates: () => templatesOf(bucket),
  store,
  access,
  aws: {
    caller: async (credentials) => {
      calls.push(`caller ${await keyOf(credentials)}`);
      return { account: callerAccount, arn: `arn:aws:sts::${callerAccount}:assumed-role/metro-access/x` };
    },
    regions: async (credentials) => {
      calls.push(`regions ${await keyOf(credentials)}`);
      return ['eu-central-2', 'us-east-1'];
    },
    instances: async (credentials, region) => {
      calls.push(`instances ${await keyOf(credentials)} ${region}`);
      return region === 'eu-central-2' ? instances : [];
    },
    publish: async (credentials) => {
      calls.push(`publish ${await keyOf(credentials)}`);
      return `${BUCKET}/metro-access-0123456789ab.yaml`;
    },
  },
  externalId: () => 'ext-generated-000000000000',
  now: () => 0,
  keys: new SigningKeys('http://127.0.0.1:1/nowhere'),
};

const rowOf = (owner: string, id: string): Promise<DeletionRow> => {
  const row = store.rows.get(id);
  if (row === undefined || row.owner !== owner) return Promise.reject(new ApiError('no such server', 404));
  const connection = row.connection === null ? undefined : store.connections.get(row.connection);
  const externalId = store.externalIds.get(owner);
  const account = connection === undefined || externalId === undefined ? null : { connection: connection.id, roleArn: connection.roleArn, externalId };
  const placed = row.instanceId !== null && (row.connection === null || account !== null);
  return Promise.resolve({ id, owner, host: HOSTS[id] ?? '', name: null, addedAt: '', instanceId: placed ? row.instanceId : null, region: placed ? row.region : null, account });
};

const linkDeps: ServerLinkDeps = {
  config: () => config,
  lookup: rowOf,
  store,
  access,
  aws: {
    describe: async (credentials, region, instanceId) => {
      calls.push(`describe ${await keyOf(credentials)} ${region} ${instanceId}`);
      return instances.filter((i) => i.instanceId === instanceId);
    },
    tag: async (credentials, region, instanceId, node, agentId) => {
      calls.push(`tag ${await keyOf(credentials)} ${region} ${instanceId} ${node} ${agentId}`);
    },
  },
  keys: awsDeps.keys,
};

let server: Server;
let base = '';

beforeAll(async () => {
  awsDeps.keys = await testKeys();
  linkDeps.keys = awsDeps.keys;
  server = createServer((req, res) => {
    if (handleServerLinkRequest(req, res, linkDeps) || handleAwsConnectionsRequest(req, res, awsDeps)) return;
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

afterAll(() => {
  server.close();
});

beforeEach(() => {
  config = READY;
  bucket = BUCKET;
  store = memoryAws();
  awsDeps.store = store;
  linkDeps.store = store;
  store.rows.set(ANDY, { owner: TEST_OWNER, instanceId: null, region: null, connection: null });
  store.rows.set(OURS, { owner: TEST_OWNER, instanceId: 'i-0own', region: 'us-east-1', connection: null });
  calls = [];
  callerAccount = '111122223333';
  refuseAssume = false;
  instances = [facts('i-0aaa1111aaaa1111', { Name: 'Andy' }), facts('i-0bbb2222bbbb2222', { metro: 'metro-zzzzzz' })];
  access.clear();
  resetConnectionsState();
});

async function call(method: string, path: string, who = TEST_OWNER, role: 'admin' | 'member' = 'admin', body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: await auth(who, role), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

async function connected(): Promise<string> {
  await call('POST', '/api/aws/link');
  const { json } = await call('POST', '/api/aws/connections', TEST_OWNER, 'admin', { roleArn: ROLE });
  return (json.connection as { id: string }).id;
}

describe('connecting an AWS account', () => {
  test('says why it is not ready: no AWS at all, no role of its own, no bucket', async () => {
    config = { ok: false, missing: [] };
    expect((await call('GET', '/api/aws')).json).toMatchObject({ ready: false, reason: expect.stringContaining('no AWS account') as unknown as string });
    config = { ok: true, config: { ...(READY.ok ? READY.config : ({} as never)), role: null } };
    expect((await call('GET', '/api/aws')).json).toMatchObject({ ready: false, reason: expect.stringContaining('no AWS role of its own') as unknown as string });
    config = READY;
    bucket = '';
    expect((await call('GET', '/api/aws')).json).toMatchObject({ ready: false, reason: expect.stringContaining('METRO_AWS_TEMPLATES') as unknown as string });
    expect((await call('POST', '/api/aws/link')).status).toBe(400);
  });

  test("the link carries the organization's one external id and Metro's role, and the template goes up with the role, never the key", async () => {
    const first = await call('POST', '/api/aws/link');
    expect(first.status).toBe(200);
    const url = new URL(first.json.url as string);
    const params = new URLSearchParams(url.hash.split('?')[1]);
    expect(params.get('param_ExternalId')).toBe('ext-generated-000000000000');
    expect(params.get('param_MetroRoleArn')).toBe(METRO_ROLE);
    store.externalIds.set(TEST_OWNER, 'ext-kept-0000000000000000');
    expect((await call('POST', '/api/aws/link')).json.externalId).toBe('ext-kept-0000000000000000');
    expect(calls).toEqual(['publish ASIAMETRO', 'publish ASIAMETRO']);
    expect((await call('POST', '/api/aws/link', TEST_OWNER, 'member')).status).toBe(403);
    expect((await call('GET', '/api/aws')).json).toMatchObject({ ready: true, metroRole: METRO_ROLE, externalId: 'ext-kept-0000000000000000', connections: [] });
  });

  test('a role is saved only once Metro took it with the external id and it answered from its own account', async () => {
    expect((await call('POST', '/api/aws/connections', TEST_OWNER, 'admin', { roleArn: ROLE })).json.error).toContain('open the Connect AWS link first');
    await call('POST', '/api/aws/link');
    expect((await call('POST', '/api/aws/connections', TEST_OWNER, 'admin', { roleArn: 'arn:aws:iam::111122223333:user/x' })).status).toBe(400);
    refuseAssume = true;
    const refused = await call('POST', '/api/aws/connections', TEST_OWNER, 'admin', { roleArn: ROLE });
    expect(refused.status).toBe(400);
    expect(refused.json.error).toContain('not authorized to perform sts:AssumeRole');
    refuseAssume = false;
    callerAccount = '999999999999';
    expect((await call('POST', '/api/aws/connections', TEST_OWNER, 'admin', { roleArn: ROLE })).json.error).toContain('not 111122223333');
    callerAccount = '111122223333';
    const saved = await call('POST', '/api/aws/connections', TEST_OWNER, 'admin', { roleArn: ROLE });
    expect(saved.status).toBe(200);
    expect(saved.json).toMatchObject({ connection: { accountId: '111122223333', roleArn: ROLE }, regions: 2 });
    expect(calls.filter((c) => c.startsWith('assume'))).toEqual(Array(3).fill(`assume ${ROLE} ext-generated-000000000000`) as string[]);
    expect((await call('POST', '/api/aws/connections', TEST_OWNER, 'admin', { roleArn: ROLE })).status).toBe(409);
    expect(((await call('GET', '/api/aws', TEST_STRANGER)).json.connections as unknown[]).length).toBe(0);
  });

  test('the servers of a connected account are listed through its role, with what each one is linked to', async () => {
    const id = await connected();
    calls = [];
    const listed = await call('GET', '/api/aws/instances', TEST_OWNER, 'member');
    expect(listed.json.errors).toEqual([]);
    expect(listed.json.instances).toEqual([
      { connection: id, accountId: '111122223333', region: 'eu-central-2', instanceId: 'i-0aaa1111aaaa1111', name: 'Andy', state: 'running', type: 't4g.medium', node: null, agentId: null },
      { connection: id, accountId: '111122223333', region: 'eu-central-2', instanceId: 'i-0bbb2222bbbb2222', name: null, state: 'running', type: 't4g.medium', node: 'metro-zzzzzz', agentId: null },
    ]);
    expect(calls.sort()).toEqual(['instances ASIACONN eu-central-2', 'instances ASIACONN us-east-1']);
  });
});

describe('linking a server to its instance in a connected account', () => {
  test('tags the instance with the box and the agent, then the server reads as linked', async () => {
    const id = await connected();
    expect((await call('GET', `/api/servers/${ANDY}/link`)).json).toEqual({ mode: 'none', connections: 1 });
    expect((await call('POST', `/api/servers/${ANDY}/link`, TEST_OWNER, 'member', { connection: id, region: 'eu-central-2', instanceId: 'i-0aaa1111aaaa1111' })).status).toBe(403);
    calls = [];
    const linked = await call('POST', `/api/servers/${ANDY}/link`, TEST_OWNER, 'admin', { connection: id, region: 'eu-central-2', instanceId: 'i-0aaa1111aaaa1111' });
    expect(linked.status).toBe(200);
    expect(linked.json).toEqual({ mode: 'linked', connection: id, accountId: '111122223333', region: 'eu-central-2', instanceId: 'i-0aaa1111aaaa1111' });
    expect(calls).toEqual(['describe ASIACONN eu-central-2 i-0aaa1111aaaa1111', `tag ASIACONN eu-central-2 i-0aaa1111aaaa1111 metro-8m4meq ${ANDY}`]);
    expect((await call('GET', '/api/aws/instances')).json.instances).toContainEqual(expect.objectContaining({ instanceId: 'i-0aaa1111aaaa1111', agentId: ANDY }));
  });

  test("refuses a server Metro launched itself, another box's instance, and an instance AWS does not list", async () => {
    const id = await connected();
    expect((await call('GET', `/api/servers/${OURS}/link`)).json).toEqual({ mode: 'metro', region: 'us-east-1', instanceId: 'i-0own' });
    expect((await call('POST', `/api/servers/${OURS}/link`, TEST_OWNER, 'admin', { connection: id, region: 'eu-central-2', instanceId: 'i-0aaa1111aaaa1111' })).status).toBe(409);
    const tagged = await call('POST', `/api/servers/${ANDY}/link`, TEST_OWNER, 'admin', { connection: id, region: 'eu-central-2', instanceId: 'i-0bbb2222bbbb2222' });
    expect(tagged.status).toBe(409);
    expect(tagged.json.error).toContain('metro=metro-zzzzzz');
    expect((await call('POST', `/api/servers/${ANDY}/link`, TEST_OWNER, 'admin', { connection: id, region: 'eu-central-2', instanceId: 'i-0ccc3333cccc3333' })).status).toBe(404);
    expect((await call('POST', `/api/servers/${ANDY}/link`, TEST_OWNER, 'admin', { connection: 'nope0000000', region: 'eu-central-2', instanceId: 'i-0aaa1111aaaa1111' })).status).toBe(404);
    expect((await call('POST', `/api/servers/${ANDY}/link`, TEST_STRANGER, 'admin', { connection: id, region: 'eu-central-2', instanceId: 'i-0aaa1111aaaa1111' })).status).toBe(404);
    expect(calls.some((c) => c.startsWith('tag'))).toBe(false);
  });

  test('unlinking, or disconnecting the account, leaves the server unlinked and AWS untouched', async () => {
    const id = await connected();
    await call('POST', `/api/servers/${ANDY}/link`, TEST_OWNER, 'admin', { connection: id, region: 'eu-central-2', instanceId: 'i-0aaa1111aaaa1111' });
    expect((await call('POST', `/api/servers/${ANDY}/link`, TEST_OWNER, 'admin', { unlink: true })).json).toEqual({ mode: 'none', connections: 1 });
    expect((await call('POST', `/api/servers/${ANDY}/link`, TEST_OWNER, 'admin', { unlink: true })).status).toBe(400);
    await call('POST', `/api/servers/${ANDY}/link`, TEST_OWNER, 'admin', { connection: id, region: 'eu-central-2', instanceId: 'i-0aaa1111aaaa1111' });
    expect((await call('DELETE', `/api/aws/connections/${id}`, TEST_OWNER, 'member')).status).toBe(403);
    expect((await call('DELETE', `/api/aws/connections/${id}`)).json).toEqual({ removed: true, unlinked: 1 });
    expect((await call('GET', `/api/servers/${ANDY}/link`)).json).toEqual({ mode: 'none', connections: 0 });
    expect((await call('DELETE', `/api/aws/connections/${id}`)).status).toBe(404);
  });
});
