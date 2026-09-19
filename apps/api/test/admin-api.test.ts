import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SigningKeys } from '@metro-labs/http/workos-token';
import { handleAdminApiRequest, type AdminApiDeps } from '../src/admin.ts';
import { readWorkosConfig } from '../src/auth/workos.ts';
import { fakeWorkos, type FakeWorkos } from './workos-fake.ts';
import { memorySlugs } from './slug-fake.ts';
import { memoryUsers } from './users-fake.ts';
import { sessionClaims } from '../../../packages/http/test/workos-fixture.ts';

let workos: FakeWorkos;
let server: Server;
let base = '';
let deps: AdminApiDeps;
const ORG = 'org_01ADMIN0000000';

beforeAll(async () => {
  workos = await fakeWorkos();
  workos.organizations.push(ORG);
  const env = { WORKOS_API_KEY: 'sk_test_fake', WORKOS_CLIENT_ID: 'client_test', WORKOS_API_BASE: workos.base };
  deps = {
    config: () => readWorkosConfig(env),
    keys: new SigningKeys(workos.issuer.url),
    slugs: memorySlugs(),
    users: memoryUsers(),
    agents: () => Promise.resolve([{ id: 'aB3-_xYz9Qw', owner: ORG, host: 'tony.example.ts.net', name: 'Tony', slug: 'tony', addedAt: '2026-09-10T00:00:00.000Z', avatar: null }]),
  };
  await deps.users.noteLogin({ id: 'user_01ABC', email: 'admin@stage.box', name: 'Stage Labs', picture: null, createdAt: '2026-09-01T10:00:00.000Z' }, '2026-09-19T10:00:00.000Z');
  await deps.users.setStatus('user_01ABC', 'approved');
  await deps.users.noteLogin({ id: 'user_02BOB', email: 'bob@stage.box', name: 'Bob', picture: null, createdAt: '2026-09-02T10:00:00.000Z' }, '2026-09-18T10:00:00.000Z');
  await deps.users.setStatus('user_02BOB', 'waitlist');
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

const token = (sub: string): string => workos.issuer.mint(sessionClaims({ sub, org_id: ORG, role: 'admin' }));

const call = (method: string, path: string, bearer?: string, body?: unknown): Promise<Response> =>
  fetch(`${base}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(bearer === undefined ? {} : { authorization: `Bearer ${bearer}` }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

describe('the operator pages', () => {
  test('only the operator may read them: no token is 401, another account is 403', async () => {
    expect((await call('GET', '/api/admin/users')).status).toBe(401);
    expect((await call('GET', '/api/admin/users', token('user_02BOB'))).status).toBe(403);
    expect((await call('GET', '/api/admin/organizations', token('user_02BOB'))).status).toBe(403);
    expect((await call('GET', '/api/admin/agents', token('user_02BOB'))).status).toBe(403);
    expect((await call('GET', '/api/admin/nothing', token('user_01ABC'))).status).toBe(404);
  });

  test('users are listed newest sign-in first with their status, and the operator can approve or reject anyone but themselves', async () => {
    const listed = (await (await call('GET', '/api/admin/users', token('user_01ABC'))).json()) as { users: Record<string, unknown>[] };
    expect(listed.users.map((u) => [u.id, u.status, u.operator])).toEqual([
      ['user_01ABC', 'approved', true],
      ['user_02BOB', 'waitlist', false],
    ]);
    expect((await call('POST', '/api/admin/users/user_02BOB/status', token('user_01ABC'), { status: 'approved' })).status).toBe(200);
    expect((await deps.users.find('user_02BOB'))?.status).toBe('approved');
    expect((await call('POST', '/api/admin/users/user_02BOB/status', token('user_01ABC'), { status: 'rejected' })).status).toBe(200);
    expect((await deps.users.find('user_02BOB'))?.status).toBe('rejected');
    expect((await call('POST', '/api/admin/users/user_02BOB/status', token('user_01ABC'), { status: 'banned' })).status).toBe(400);
    expect((await call('POST', '/api/admin/users/user_01ABC/status', token('user_01ABC'), { status: 'rejected' })).status).toBe(400);
    expect((await call('POST', '/api/admin/users/user_09NOPE/status', token('user_01ABC'), { status: 'approved' })).status).toBe(404);
    expect((await call('POST', '/api/admin/users/user_02BOB/status', token('user_02BOB'), { status: 'approved' })).status).toBe(403);
  });

  test('organizations come from WorkOS with their metro slug, and agents from the table with their organization name', async () => {
    const orgs = (await (await call('GET', '/api/admin/organizations', token('user_01ABC'))).json()) as { organizations: Record<string, unknown>[] };
    expect(orgs.organizations).toEqual([{ id: ORG, name: 'Stage Labs', createdAt: '2026-09-10T00:00:00.000Z', slug: 'stage-labs' }]);
    const agents = (await (await call('GET', '/api/admin/agents', token('user_01ABC'))).json()) as { agents: Record<string, unknown>[] };
    expect(agents.agents).toEqual([{ id: 'aB3-_xYz9Qw', owner: ORG, host: 'tony.example.ts.net', name: 'Tony', slug: 'tony', addedAt: '2026-09-10T00:00:00.000Z', avatar: null, organizationName: 'Stage Labs' }]);
  });
});
