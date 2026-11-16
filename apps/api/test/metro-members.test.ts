import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { sessionClaims } from '../../../packages/http/test/workos-fixture.ts';
import { accountId } from '../src/db/account-ids.ts';
import { authSessions, memberships, organizations, users } from '../src/db/schema.ts';
import { ADMIN, claimsOf, harness, NOW, ORG, type Harness, type TokenBody } from './metro-accounts-fixture.ts';
import { PGLITE_START_MS, PGLITE_STEP_MS } from './pglite-db.ts';

let h: Harness;
const OPERATOR = accountId('user', NOW + 5);

beforeAll(async () => {
  h = await harness('metro');
}, PGLITE_START_MS);

beforeEach(async () => {
  await h.seed();
  h.clock.now = NOW;
  h.setMode('metro');
  await h.held.db.insert(users).values({ id: OPERATOR, email: 'admin@stage.box', name: 'Operator', updatedAt: 'x' });
}, PGLITE_STEP_MS);

afterEach(() => {
  delete process.env.OPERATOR_USER_ID;
});

afterAll(async () => {
  await h.close();
});

const bearer = (sub: string, role: 'admin' | 'member' = 'admin', organization = ORG): string => h.workos.issuer.mint(sessionClaims({ sub, org_id: organization, role }));

interface Overview {
  name: string;
  members: { membershipId: string; userId: string; email: string | null; name: string | null; role: string }[];
  invitations: unknown[];
}

const overview = async (who = bearer(ADMIN)): Promise<Overview> => (await (await h.json('GET', '/api/organization', undefined, who)).json()) as Overview;

describe('members kept by Metro', () => {
  test('an admin adds a person by email at once, no email is sent, and their first sign-in with that address claims the seat', async () => {
    const added = await h.json('POST', '/api/organization/invitations', { email: ' Ana@Example.com ', role: 'member' }, bearer(ADMIN));
    expect(added.status).toBe(200);
    const answer = (await added.json()) as { added: boolean; member: { membershipId: string; userId: string; email: string; name: null; role: string } };
    expect(answer).toMatchObject({ added: true, member: { email: 'ana@example.com', name: null, role: 'member' } });
    expect(answer.member.membershipId).toMatch(/^om_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(h.workos.calls.filter((c) => c.path === '/user_management/invitations')).toEqual([]);
    const listed = await overview();
    expect(listed.invitations).toEqual([]);
    expect(listed.members.map((m) => [m.email, m.role])).toEqual([['admin@example.com', 'admin'], ['ana@example.com', 'member']]);
    expect((await h.json('POST', '/api/organization/invitations', { email: 'ana@example.com', role: 'member' }, bearer(ADMIN))).status).toBe(409);
    expect((await h.json('POST', '/api/organization/invitations', { email: 'eve@example.com', role: 'member' }, bearer(answer.member.userId, 'member'))).status).toBe(403);
    const tokens = await h.tokens('google', claimsOf('google'));
    expect(tokens).toMatchObject({ organization: ORG, user: { id: answer.member.userId, name: 'Ana Lima' } });
    expect((await overview()).members.find((m) => m.userId === answer.member.userId)?.name).toBe('Ana Lima');
  });

  test('roles change and people leave, but never the last admin and never yourself', async () => {
    const added = (await (await h.json('POST', '/api/organization/invitations', { email: 'bob@example.com', role: 'member' }, bearer(ADMIN))).json()) as { member: { membershipId: string; userId: string } };
    const mine = (await overview()).members.find((m) => m.userId === ADMIN)?.membershipId ?? '';
    expect((await h.json('PUT', `/api/organization/members/${mine}`, { role: 'member' }, bearer(ADMIN))).status).toBe(400);
    expect((await h.json('DELETE', `/api/organization/members/${mine}`, undefined, bearer(ADMIN))).status).toBe(400);
    expect((await h.json('PUT', `/api/organization/members/${added.member.membershipId}`, { role: 'admin' }, bearer(ADMIN))).status).toBe(200);
    expect((await h.json('PUT', `/api/organization/members/${mine}`, { role: 'member' }, bearer(added.member.userId))).status).toBe(200);
    expect((await h.json('PUT', `/api/organization/members/${added.member.membershipId}`, { role: 'member' }, bearer(added.member.userId))).status).toBe(400);
    const carol = (await (await h.json('POST', '/api/organization/invitations', { email: 'carol@example.com', role: 'member' }, bearer(added.member.userId))).json()) as { member: { membershipId: string; userId: string } };
    expect((await h.json('DELETE', `/api/organization/members/${carol.member.membershipId}`, undefined, bearer(ADMIN, 'admin'))).status).toBe(403);
    const rows = await h.held.db.select().from(memberships).where(eq(memberships.organization, ORG));
    expect(rows.map((r) => [r.userId, r.role]).sort()).toEqual([[ADMIN, 'member'], [added.member.userId, 'admin'], [carol.member.userId, 'member']].sort());
    expect((await h.json('DELETE', `/api/organization/members/${mine}`, undefined, bearer(added.member.userId))).status).toBe(200);
    expect((await overview(bearer(added.member.userId))).members.map((m) => m.userId).sort()).toEqual([added.member.userId, carol.member.userId].sort());
  });

  test('a rename is kept in Postgres and shows on the next tokens', async () => {
    expect((await h.json('PUT', '/api/organization', { name: 'Stage Labs AG' }, bearer(ADMIN))).status).toBe(200);
    expect((await h.held.db.select().from(organizations).where(eq(organizations.id, ORG)))[0]?.name).toBe('Stage Labs AG');
    expect((await overview()).name).toBe('Stage Labs AG');
    expect((await h.json('POST', '/api/organization/invitations/inv_000001/revoke', undefined, bearer(ADMIN))).status).toBe(404);
  });

  test('with WorkOS the same routes still read and invite through WorkOS', async () => {
    h.setMode('workos');
    const listed = await overview(bearer('user_01ABC'));
    expect(listed.members.map((m) => m.email)).toEqual(['admin@stage.box', 'bob@stage.box']);
    expect((await h.json('POST', '/api/organization/invitations', { email: 'new@example.com', role: 'member' }, bearer('user_01ABC'))).status).toBe(200);
    expect(h.workos.invitations.map((i) => i.email)).toContain('new@example.com');
    expect(await h.held.db.select().from(users).where(eq(users.email, 'new@example.com'))).toEqual([]);
  });
});

describe('login links, the operator\'s fallback', () => {
  const redeem = (code: string, from = '203.0.113.7'): Promise<Response> => h.json('POST', '/api/auth/link', { code }, undefined, { 'cf-connecting-ip': from });
  const codeOf = (url: string): string => /#\/auth\/link\/([A-Za-z0-9_-]{43})$/.exec(url)?.[1] ?? '';

  test('the operator makes a link shown once, it signs its person in again and again, and removing it ends that', async () => {
    const made = await h.json('POST', `/api/admin/users/${ADMIN}/login-link`, undefined, bearer(OPERATOR));
    expect(made.status).toBe(200);
    const link = (await made.json()) as { id: string; url: string };
    expect(link.url).toMatch(/^https:\/\/metro\.box\/#\/auth\/link\/[A-Za-z0-9_-]{43}$/);
    const code = codeOf(link.url);
    const listed = (await (await h.json('GET', '/api/admin/users', undefined, bearer(OPERATOR))).json()) as { users: { id: string; loginLink: { id: string } | null }[] };
    expect(listed.users.find((u) => u.id === ADMIN)?.loginLink?.id).toBe(link.id);
    expect(JSON.stringify(listed)).not.toContain(code);
    for (let round = 0; round < 2; round += 1) {
      const hash = ((await (await redeem(code)).json()) as { hash: string }).hash;
      const handoff = /^#\/auth\/(.+)$/.exec(hash)?.[1] ?? '';
      const tokens = (await (await h.json('POST', '/api/auth/exchange', { code: handoff })).json()) as TokenBody;
      expect(tokens).toMatchObject({ organization: ORG, user: { id: ADMIN } });
    }
    expect((await h.held.db.select().from(authSessions)).map((s) => s.method)).toEqual(['link', 'link']);
    expect((await h.json('DELETE', `/api/admin/users/${ADMIN}/login-link`, undefined, bearer(OPERATOR))).status).toBe(200);
    expect((await redeem(code)).status).toBe(404);
    expect((await redeem('not a code')).status).toBe(400);
  });

  test('a new link replaces the old one, only the operator makes them, and only with Metro accounts', async () => {
    const first = ((await (await h.json('POST', `/api/admin/users/${ADMIN}/login-link`, undefined, bearer(OPERATOR))).json()) as { url: string }).url;
    await h.json('POST', `/api/admin/users/${ADMIN}/login-link`, undefined, bearer(OPERATOR));
    expect((await redeem(codeOf(first), '203.0.113.8')).status).toBe(404);
    expect((await h.json('POST', `/api/admin/users/${ADMIN}/login-link`, undefined, bearer(ADMIN))).status).toBe(403);
    expect((await h.json('POST', '/api/admin/users/user_01NOBODY0000000000000000000/login-link', undefined, bearer(OPERATOR))).status).toBe(404);
    h.setMode('workos');
    expect((await h.json('POST', `/api/admin/users/${ADMIN}/login-link`, undefined, bearer(OPERATOR))).status).toBe(409);
    expect((await redeem('A'.repeat(43), '203.0.113.8')).status).toBe(404);
  });

  test('redeeming is limited to 30 tries a minute from one address', async () => {
    for (let i = 0; i < 30; i += 1) expect((await redeem('B'.repeat(43), '198.51.100.9')).status).toBe(404);
    expect((await redeem('B'.repeat(43), '198.51.100.9')).status).toBe(429);
    expect((await redeem('B'.repeat(43), '198.51.100.10')).status).toBe(404);
    h.clock.now += 61_000;
    expect((await redeem('B'.repeat(43), '198.51.100.9')).status).toBe(404);
  });

  test('a rejected person cannot use a link', async () => {
    const link = ((await (await h.json('POST', `/api/admin/users/${ADMIN}/login-link`, undefined, bearer(OPERATOR))).json()) as { url: string }).url;
    await h.deps.users.setStatus(ADMIN, 'rejected');
    expect(await (await redeem(codeOf(link), '203.0.113.11')).json()).toEqual({ hash: '#/login?refused=not-open' });
  });
});

describe('the operator', () => {
  test('is the operator email or OPERATOR_USER_ID, so a changed email does not lock them out', async () => {
    const moved = accountId('user', NOW + 9);
    await h.held.db.insert(users).values({ id: moved, email: 'someone-else@example.com', updatedAt: 'x' });
    expect((await h.json('GET', '/api/admin/users', undefined, bearer(moved))).status).toBe(403);
    process.env.OPERATOR_USER_ID = moved;
    const listed = await h.json('GET', '/api/admin/users', undefined, bearer(moved));
    expect(listed.status).toBe(200);
    const rows = ((await listed.json()) as { users: { id: string; operator: boolean }[] }).users;
    expect(rows.filter((u) => u.operator).map((u) => u.id).sort()).toEqual([OPERATOR, moved].sort());
    expect((await h.json('GET', '/api/admin/users', undefined, bearer(OPERATOR))).status).toBe(200);
  });

  test('organizations and agents in the operator pages come from Postgres with Metro accounts', async () => {
    const listed = (await (await h.json('GET', '/api/admin/organizations', undefined, bearer(OPERATOR))).json()) as { organizations: { id: string; name: string; slug: string }[] };
    expect(listed.organizations.map((o) => [o.id, o.name, o.slug]).sort()).toEqual([
      ['org_01KELSEWHERE0000000000000', 'Elsewhere', 'elsewhere'],
      [ORG, 'Stage Labs', 'stage-labs'],
    ].sort());
  });
});
