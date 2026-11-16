import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { sessionClaims } from '../../../packages/http/test/workos-fixture.ts';
import { accountId } from '../src/db/account-ids.ts';
import { authSessions, loginLinks, memberships, organizations, users } from '../src/db/schema.ts';
import { ADMIN, claimsOf, harness, NOW, ORG, type Harness, type TokenBody } from './metro-accounts-fixture.ts';
import { PGLITE_START_MS, PGLITE_STEP_MS } from './pglite-db.ts';

let h: Harness;
const OPERATOR = accountId('user', NOW + 5);
const DAY = 24 * 60 * 60_000;

beforeAll(async () => {
  h = await harness('metro');
}, PGLITE_START_MS);

beforeEach(async () => {
  await h.seed();
  h.clock.now = NOW;
  h.setMode('metro');
  await h.held.db.insert(users).values({ id: OPERATOR, email: 'admin@stage.box', name: 'Operator', updatedAt: 'x' });
  process.env.OPERATOR_USER_ID = OPERATOR;
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
  members: { membershipId: string; userId: string; email: string | null; name: string | null; picture: string | null; role: string }[];
  invitations: unknown[];
}

interface Added {
  added: boolean;
  member: Record<string, unknown> & { membershipId: string };
}

const overview = async (who = bearer(ADMIN)): Promise<Overview> => (await (await h.json('GET', '/api/organization', undefined, who)).json()) as Overview;

const add = async (email: string, role: 'admin' | 'member' = 'member', who = bearer(ADMIN)): Promise<Added> => {
  const res = await h.json('POST', '/api/organization/invitations', { email, role }, who);
  expect(res.status).toBe(200);
  return (await res.json()) as Added;
};

const userOf = async (email: string): Promise<string> => (await h.held.db.select().from(users).where(eq(users.email, email)))[0]?.id ?? '';

describe('members kept by Metro', () => {
  test('an admin adds a person by email at once, no email is sent, and their first sign-in with that address claims the seat', async () => {
    const answer = await add(' Ana@Example.com ');
    expect(answer).toEqual({ added: true, member: { membershipId: answer.member.membershipId, email: 'ana@example.com', role: 'member' } });
    expect(answer.member.membershipId).toMatch(/^om_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(h.workos.calls.filter((c) => c.path === '/user_management/invitations')).toEqual([]);
    const listed = await overview();
    expect(listed.invitations).toEqual([]);
    expect(listed.members.map((m) => [m.email, m.role])).toEqual([['admin@example.com', 'admin'], ['ana@example.com', 'member']]);
    expect((await h.json('POST', '/api/organization/invitations', { email: 'ana@example.com', role: 'member' }, bearer(ADMIN))).status).toBe(409);
    expect((await h.json('POST', '/api/organization/invitations', { email: 'eve@example.com', role: 'member' }, bearer(await userOf('ana@example.com'), 'member'))).status).toBe(403);
    expect((await h.json('POST', '/api/organization/invitations', { email: 'ånа@example.com', role: 'member' }, bearer(ADMIN))).status).toBe(400);
    const tokens = await h.tokens('google', claimsOf('google'));
    expect(tokens).toMatchObject({ organization: ORG, user: { id: await userOf('ana@example.com'), name: 'Ana Lima' } });
    expect((await overview()).members.find((m) => m.email === 'ana@example.com')?.name).toBe('Ana Lima');
  });

  test('adding someone who already has an account answers only the email and role, and the list hides their name and picture until they sign in', async () => {
    const known = accountId('user', NOW + 7);
    await h.held.db.insert(users).values({ id: known, email: 'known@example.com', name: 'Known Person', picture: 'https://pic.example/k.png', lastLoginAt: new Date(NOW - DAY).toISOString(), updatedAt: 'x' });
    const answer = await add('known@example.com');
    expect(JSON.stringify(answer)).not.toContain('Known Person');
    expect(JSON.stringify(answer)).not.toContain(known);
    expect(answer.member).toEqual({ membershipId: answer.member.membershipId, email: 'known@example.com', role: 'member' });
    const shown = (await overview()).members.find((m) => m.email === 'known@example.com');
    expect(shown).toMatchObject({ name: null, picture: null });
    expect((await overview()).members.find((m) => m.userId === ADMIN)?.name).toBe('Ada Admin');
    await h.held.db.update(users).set({ lastLoginAt: new Date(h.clock.now + 1000).toISOString() }).where(eq(users.id, known));
    expect((await overview()).members.find((m) => m.email === 'known@example.com')).toMatchObject({ name: 'Known Person', picture: 'https://pic.example/k.png' });
  });

  test('roles change and people leave, but never the last admin and never yourself', async () => {
    const bob = (await add('bob@example.com')).member.membershipId;
    const bobId = await userOf('bob@example.com');
    const mine = (await overview()).members.find((m) => m.userId === ADMIN)?.membershipId ?? '';
    expect((await h.json('PUT', `/api/organization/members/${mine}`, { role: 'member' }, bearer(ADMIN))).status).toBe(400);
    expect((await h.json('DELETE', `/api/organization/members/${mine}`, undefined, bearer(ADMIN))).status).toBe(400);
    expect((await h.json('PUT', `/api/organization/members/${bob}`, { role: 'admin' }, bearer(ADMIN))).status).toBe(200);
    expect((await h.json('PUT', `/api/organization/members/${mine}`, { role: 'member' }, bearer(bobId))).status).toBe(200);
    expect((await h.json('PUT', `/api/organization/members/${bob}`, { role: 'member' }, bearer(bobId))).status).toBe(400);
    const carol = (await add('carol@example.com', 'member', bearer(bobId))).member.membershipId;
    expect((await h.json('DELETE', `/api/organization/members/${carol}`, undefined, bearer(ADMIN, 'admin'))).status).toBe(403);
    const rows = await h.held.db.select().from(memberships).where(eq(memberships.organization, ORG));
    expect(rows.map((r) => [r.userId, r.role]).sort()).toEqual([[ADMIN, 'member'], [bobId, 'admin'], [await userOf('carol@example.com'), 'member']].sort());
    expect((await h.json('DELETE', `/api/organization/members/${mine}`, undefined, bearer(bobId))).status).toBe(200);
    expect((await overview(bearer(bobId))).members.map((m) => m.email).sort()).toEqual(['bob@example.com', 'carol@example.com']);
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
  const redeem = (code: string, from = '203.0.113.7'): Promise<Response> => h.json('POST', '/api/auth/link', { code }, undefined, { 'fly-client-ip': from });
  const codeOf = (url: string): string => /#\/auth\/link\/([A-Za-z0-9_-]{43})$/.exec(url)?.[1] ?? '';
  const make = async (user = ADMIN): Promise<{ id: string; url: string; expiresAt: number }> => {
    const res = await h.json('POST', `/api/admin/users/${user}/login-link`, undefined, bearer(OPERATOR));
    expect(res.status).toBe(200);
    return (await res.json()) as { id: string; url: string; expiresAt: number };
  };
  const signIn = async (code: string, from?: string): Promise<TokenBody> => {
    const hash = ((await (await redeem(code, from)).json()) as { hash: string }).hash;
    const handoff = /^#\/auth\/(.+)$/.exec(hash)?.[1] ?? '';
    return (await (await h.json('POST', '/api/auth/exchange', { code: handoff })).json()) as TokenBody;
  };

  test('a link is shown once, works once within 7 days, and its session remembers it', async () => {
    const link = await make();
    expect(link.url).toMatch(/^https:\/\/metro\.box\/#\/auth\/link\/[A-Za-z0-9_-]{43}$/);
    expect(link.expiresAt).toBe(NOW + 7 * DAY);
    const code = codeOf(link.url);
    const listed = (await (await h.json('GET', '/api/admin/users', undefined, bearer(OPERATOR))).json()) as { users: { id: string; loginLink: { id: string; usedAt: number | null } | null }[] };
    expect(listed.users.find((u) => u.id === ADMIN)?.loginLink).toMatchObject({ id: link.id, usedAt: null });
    expect(JSON.stringify(listed)).not.toContain(code);
    expect(await signIn(code)).toMatchObject({ organization: ORG, user: { id: ADMIN } });
    expect((await redeem(code)).status).toBe(404);
    expect((await h.held.db.select().from(authSessions)).map((s) => [s.method, s.link])).toEqual([['link', link.id]]);
    const late = await make();
    h.clock.now += 7 * DAY + 1;
    expect((await redeem(codeOf(late.url))).status).toBe(404);
  });

  test('removing a link also signs out the session it opened', async () => {
    const link = await make();
    const tokens = await signIn(codeOf(link.url));
    expect((await h.json('POST', '/api/auth/refresh', { refreshToken: tokens.refreshToken, organization: ORG })).status).toBe(200);
    const removed = await h.json('DELETE', `/api/admin/users/${ADMIN}/login-link`, undefined, bearer(OPERATOR));
    expect(await removed.json()).toEqual({ revoked: true, sessions: 1 });
    expect((await h.held.db.select().from(authSessions))[0]?.revokedAt).not.toBeNull();
    expect((await redeem('not a code')).status).toBe(400);
  });

  test('a new link replaces one still waiting, the operator gets none, only the operator makes them, and only with Metro accounts', async () => {
    const first = await make();
    await make();
    expect((await redeem(codeOf(first.url), '203.0.113.8')).status).toBe(404);
    expect((await h.held.db.select().from(loginLinks).where(eq(loginLinks.id, first.id)))[0]?.revokedAt).not.toBeNull();
    expect((await h.json('POST', `/api/admin/users/${OPERATOR}/login-link`, undefined, bearer(OPERATOR))).status).toBe(400);
    expect((await h.json('POST', `/api/admin/users/${ADMIN}/login-link`, undefined, bearer(ADMIN))).status).toBe(403);
    expect((await h.json('POST', '/api/admin/users/user_01NOBODY0000000000000000000/login-link', undefined, bearer(OPERATOR))).status).toBe(404);
    h.setMode('workos');
    expect((await h.json('POST', `/api/admin/users/${ADMIN}/login-link`, undefined, bearer(OPERATOR))).status).toBe(409);
    expect((await redeem('A'.repeat(43), '203.0.113.8')).status).toBe(404);
  });

  test('redeeming is limited to 30 tries a minute from one Fly client address', async () => {
    for (let i = 0; i < 30; i += 1) expect((await redeem('B'.repeat(43), '198.51.100.9')).status).toBe(404);
    expect((await redeem('B'.repeat(43), '198.51.100.9')).status).toBe(429);
    expect((await h.json('POST', '/api/auth/link', { code: 'B'.repeat(43) }, undefined, { 'fly-client-ip': '198.51.100.9', 'cf-connecting-ip': '203.0.113.99' })).status).toBe(429);
    expect((await redeem('B'.repeat(43), '198.51.100.10')).status).toBe(404);
    h.clock.now += 61_000;
    expect((await redeem('B'.repeat(43), '198.51.100.9')).status).toBe(404);
  });

  test('a rejected person cannot use a link', async () => {
    const link = await make();
    await h.deps.users.setStatus(ADMIN, 'rejected');
    expect(await (await redeem(codeOf(link.url), '203.0.113.11')).json()).toEqual({ hash: '#/login?refused=not-open' });
  });
});

describe('the operator', () => {
  test('with Metro accounts only OPERATOR_USER_ID is the operator, so a sign-in that claims the operator email gains nothing', async () => {
    const moved = accountId('user', NOW + 9);
    await h.held.db.insert(users).values({ id: moved, email: 'someone-else@example.com', updatedAt: 'x' });
    expect((await h.json('GET', '/api/admin/users', undefined, bearer(moved))).status).toBe(403);
    const me = async (who: string): Promise<unknown> => ((await (await h.json('GET', '/api/auth/me', undefined, bearer(who))).json()) as { operator: unknown }).operator;
    expect(await me(OPERATOR)).toBe(true);
    process.env.OPERATOR_USER_ID = moved;
    expect((await h.json('GET', '/api/admin/users', undefined, bearer(moved))).status).toBe(200);
    expect((await h.json('GET', '/api/admin/users', undefined, bearer(OPERATOR))).status).toBe(403);
    expect(await me(OPERATOR)).toBe(false);
    expect(await me(moved)).toBe(true);
    h.setMode('workos');
    expect((await h.json('GET', '/api/admin/users', undefined, bearer(OPERATOR))).status).toBe(200);
    const rows = ((await (await h.json('GET', '/api/admin/users', undefined, bearer(moved))).json()) as { users: { id: string; operator: boolean }[] }).users;
    expect(rows.filter((u) => u.operator).map((u) => u.id).sort()).toEqual([OPERATOR, moved].sort());
  });

  test('organizations in the operator pages come from Postgres with Metro accounts', async () => {
    const listed = (await (await h.json('GET', '/api/admin/organizations', undefined, bearer(OPERATOR))).json()) as { organizations: { id: string; name: string; slug: string }[] };
    expect(listed.organizations.map((o) => [o.id, o.name, o.slug]).sort()).toEqual([
      ['org_01KELSEWHERE0000000000000', 'Elsewhere', 'elsewhere'],
      [ORG, 'Stage Labs', 'stage-labs'],
    ].sort());
  });
});
