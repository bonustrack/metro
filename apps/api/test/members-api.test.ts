import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SigningKeys } from '@metro-labs/http/workos-token';
import { handleMembersApiRequest } from '../src/auth/members.ts';
import { readWorkosConfig } from '../src/auth/workos.ts';
import { fakeWorkos, type FakeWorkos } from './workos-fake.ts';
import { memorySlugs } from './slug-fake.ts';
import { sessionClaims } from '../../../packages/http/test/workos-fixture.ts';

const ORG = 'org_01STAGELABS000';
let workos: FakeWorkos;
let server: Server;
let base = '';

beforeAll(async () => {
  workos = await fakeWorkos();
  const env = { WORKOS_API_KEY: 'sk_test_fake', WORKOS_CLIENT_ID: 'client_test', WORKOS_API_BASE: workos.base };
  const deps = { config: () => readWorkosConfig(env), keys: new SigningKeys(workos.issuer.url), slugs: memorySlugs() };
  server = createServer((req, res) => {
    if (handleMembersApiRequest(req, res, deps)) return;
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => {
    server.listen(0, '127.0.0.1', r);
  });
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

afterAll(async () => {
  server.close();
  await workos.close();
});

const token = (claims: Record<string, unknown> = {}): string => workos.issuer.mint(sessionClaims({ sub: 'user_01ABC', org_id: ORG, role: 'admin', ...claims }));
const call = (method: string, path: string, who = token(), body?: unknown): Promise<Response> =>
  fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${who}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

interface Overview {
  id: string;
  name: string;
  self: string;
  role: string;
  members: { membershipId: string; userId: string; email: string; name: string | null; role: string }[];
  invitations: { id: string; email: string; role: string }[];
}

describe('the members of an organization on metro.box', () => {
  test('a member reads the organization, its people with their roles, and the pending invitations', async () => {
    const res = await call('GET', '/api/organization', token({ sub: 'user_02BOB', role: 'member' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Overview;
    expect(body).toMatchObject({ id: ORG, name: 'Stage Labs', self: 'user_02BOB', role: 'member' });
    expect(body.members.map((m) => [m.email, m.role, m.name])).toEqual([
      ['admin@stage.box', 'admin', 'Stage Labs'],
      ['bob@stage.box', 'member', 'Bob'],
    ]);
    expect(body.invitations).toEqual([]);
  });

  test('an admin invites by email with a role, sees it pending, and can revoke it; a member may not', async () => {
    expect((await call('POST', '/api/organization/invitations', token({ sub: 'user_02BOB', role: 'member' }), { email: 'x@stage.box', role: 'member' })).status).toBe(403);
    expect((await call('POST', '/api/organization/invitations', token(), { email: 'not an email', role: 'member' })).status).toBe(400);
    expect((await call('POST', '/api/organization/invitations', token(), { email: 'carol@stage.box', role: 'owner' })).status).toBe(400);
    const sent = await call('POST', '/api/organization/invitations', token(), { email: 'Carol@Stage.box', role: 'member' });
    expect(sent.status).toBe(200);
    expect(await sent.json()).toMatchObject({ email: 'carol@stage.box', role: 'member' });
    const pending = ((await (await call('GET', '/api/organization')).json()) as Overview).invitations;
    expect(pending.map((i) => i.email)).toEqual(['carol@stage.box']);
    const id = pending[0]?.id ?? '';
    expect((await call('POST', `/api/organization/invitations/${id}/revoke`, token({ sub: 'user_02BOB', role: 'member' }))).status).toBe(403);
    expect((await call('POST', `/api/organization/invitations/${id}/revoke`)).status).toBe(200);
    expect(((await (await call('GET', '/api/organization')).json()) as Overview).invitations).toEqual([]);
  });

  test('an admin changes a role and removes a member, but never itself and never the last admin', async () => {
    expect((await call('PUT', '/api/organization/members/om_bob', token(), { role: 'admin' })).status).toBe(200);
    expect(workos.members.find((m) => m.id === 'om_bob')?.role).toBe('admin');
    expect((await call('PUT', '/api/organization/members/om_admin', token(), { role: 'member' })).status).toBe(400);
    expect((await call('PUT', '/api/organization/members/om_bob', token(), { role: 'member' })).status).toBe(200);
    expect((await call('PUT', '/api/organization/members/om_admin', token({ sub: 'user_02BOB', role: 'admin' }), { role: 'member' })).status).toBe(400);
    expect((await call('DELETE', '/api/organization/members/om_admin')).status).toBe(400);
    expect((await call('DELETE', '/api/organization/members/om_nobody')).status).toBe(404);
    expect((await call('DELETE', '/api/organization/members/om_bob', token({ sub: 'user_02BOB', role: 'member' }))).status).toBe(403);
    expect((await call('DELETE', '/api/organization/members/om_bob')).status).toBe(200);
    expect(workos.members.map((m) => m.id)).toEqual(['om_admin']);
  });

  test('an admin renames the organization; a member may not, and a bad name is refused', async () => {
    expect((await call('PUT', '/api/organization', token({ sub: 'user_02BOB', role: 'member' }), { name: 'Nope' })).status).toBe(403);
    expect((await call('PUT', '/api/organization', token(), { name: 'x' })).status).toBe(400);
    const renamed = await call('PUT', '/api/organization', token(), { name: '  Stage Labs SA ' });
    expect(renamed.status).toBe(200);
    expect(await renamed.json()).toEqual({ id: ORG, name: 'Stage Labs SA', slug: 'stage-labs' });
    expect(((await (await call('GET', '/api/organization')).json()) as Overview).name).toBe('Stage Labs SA');
  });

  test('an admin sets the slug; a taken one is 409, a bad one 400, and the overview carries it', async () => {
    expect(((await (await call('GET', '/api/organization')).json()) as { slug: string }).slug).toBe('stage-labs');
    expect((await call('PUT', '/api/organization', token(), { slug: 'Bad Slug' })).status).toBe(400);
    expect((await call('PUT', '/api/organization', token(), { slug: 'members' })).status).toBe(400);
    const set = await call('PUT', '/api/organization', token(), { slug: 'Stage' });
    expect(set.status).toBe(200);
    expect(((await set.json()) as { slug: string }).slug).toBe('stage');
    expect(((await (await call('GET', '/api/organization')).json()) as { slug: string }).slug).toBe('stage');
    expect((await call('PUT', '/api/organization', token({ sub: 'user_02BOB', role: 'member' }), { slug: 'other' })).status).toBe(403);
    expect((await call('PUT', '/api/organization', token(), {})).status).toBe(400);
  });

  test('no token is 401, a token without an organization is 409, a wrong method 405, and preflight passes', async () => {
    expect((await fetch(`${base}/api/organization`)).status).toBe(401);
    expect((await call('GET', '/api/organization', token({ org_id: undefined, role: undefined }))).status).toBe(409);
    expect((await call('DELETE', '/api/organization')).status).toBe(405);
    expect((await call('GET', '/api/organization/nothing')).status).toBe(404);
    expect((await fetch(`${base}/api/organization`, { method: 'OPTIONS' })).status).toBe(204);
  });
});
