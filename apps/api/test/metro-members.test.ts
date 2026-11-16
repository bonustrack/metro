import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { accountId } from '../src/db/account-ids.ts';
import { memberships, organizations, users } from '../src/db/schema.ts';
import { ADMIN, claimsOf, harness, NOW, ORG, type Harness } from './metro-accounts-fixture.ts';
import { PGLITE_START_MS, PGLITE_STEP_MS } from './pglite-db.ts';

let h: Harness;
const OPERATOR = accountId('user', NOW + 5);
const DAY = 24 * 60 * 60_000;

beforeAll(async () => {
  h = await harness();
}, PGLITE_START_MS);

beforeEach(async () => {
  await h.seed();
  h.clock.now = NOW;
  await h.held.db.insert(users).values({ id: OPERATOR, email: 'admin@stage.box', name: 'Operator', updatedAt: 'x' });
  process.env.OPERATOR_USER_ID = OPERATOR;
}, PGLITE_STEP_MS);

afterEach(() => {
  delete process.env.OPERATOR_USER_ID;
});

afterAll(async () => {
  await h.close();
});

const bearer = (sub: string, role: 'admin' | 'member' = 'admin', organization = ORG): string => h.bearer({ sub, org_id: organization, role });

interface Overview {
  name: string;
  members: { membershipId: string; userId: string; email: string | null; name: string | null; picture: string | null; role: string }[];
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
    const listed = await overview();
    expect(listed).not.toHaveProperty('invitations');
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
    await h.held.db.insert(users).values({ id: known, email: 'known@example.com', name: 'Known Person', picture: 'https://pic.example/k.png', avatar: 'data:image/png;base64,AAAA', lastLoginAt: new Date(NOW - DAY).toISOString(), updatedAt: 'x' });
    const answer = await add('known@example.com');
    expect(JSON.stringify(answer)).not.toContain('Known Person');
    expect(JSON.stringify(answer)).not.toContain(known);
    expect(answer.member).toEqual({ membershipId: answer.member.membershipId, email: 'known@example.com', role: 'member' });
    const shown = (await overview()).members.find((m) => m.email === 'known@example.com');
    expect(shown).toMatchObject({ name: null, picture: null });
    expect((await overview()).members.find((m) => m.userId === ADMIN)?.name).toBe('Ada Admin');
    await h.held.db.update(users).set({ lastLoginAt: new Date(h.clock.now + 1000).toISOString() }).where(eq(users.id, known));
    expect((await overview()).members.find((m) => m.email === 'known@example.com')).toMatchObject({ name: 'Known Person', picture: 'data:image/png;base64,AAAA' });
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

});

describe('the organization routes', () => {
  const slugOf = async (): Promise<string> => ((await (await h.json('GET', '/api/organization', undefined, bearer(ADMIN))).json()) as { slug: string }).slug;

  test('an admin renames the organization; a member may not, and a bad name is refused', async () => {
    expect((await h.json('PUT', '/api/organization', { name: 'Nope' }, bearer(ADMIN, 'member'))).status).toBe(403);
    expect((await h.json('PUT', '/api/organization', { name: 'x' }, bearer(ADMIN))).status).toBe(400);
    const renamed = await h.json('PUT', '/api/organization', { name: '  Stage Labs SA ' }, bearer(ADMIN));
    expect(renamed.status).toBe(200);
    expect(await renamed.json()).toEqual({ id: ORG, name: 'Stage Labs SA', slug: 'stage-labs' });
  });

  test('an admin sets the slug; a taken one is 409, a bad one 400, and the overview carries it', async () => {
    expect(await slugOf()).toBe('stage-labs');
    expect((await h.json('PUT', '/api/organization', { slug: 'Bad Slug' }, bearer(ADMIN))).status).toBe(400);
    expect((await h.json('PUT', '/api/organization', { slug: 'members' }, bearer(ADMIN))).status).toBe(400);
    expect((await h.json('PUT', '/api/organization', { slug: 'elsewhere' }, bearer(ADMIN))).status).toBe(409);
    const set = await h.json('PUT', '/api/organization', { slug: 'Stage' }, bearer(ADMIN));
    expect(set.status).toBe(200);
    expect(((await set.json()) as { slug: string }).slug).toBe('stage');
    expect(await slugOf()).toBe('stage');
    expect((await h.json('PUT', '/api/organization', { slug: 'other' }, bearer(ADMIN, 'member'))).status).toBe(403);
    expect((await h.json('PUT', '/api/organization', {}, bearer(ADMIN))).status).toBe(400);
  });

  test('an unknown member is 404 and a member may not remove anyone', async () => {
    const bob = (await add('bob@example.com')).member.membershipId;
    expect((await h.json('DELETE', '/api/organization/members/om_nobody', undefined, bearer(ADMIN))).status).toBe(404);
    expect((await h.json('DELETE', `/api/organization/members/${bob}`, undefined, bearer(await userOf('bob@example.com'), 'member'))).status).toBe(403);
    expect((await h.json('DELETE', `/api/organization/members/${bob}`, undefined, bearer(ADMIN))).status).toBe(200);
  });

  test('no token is 401, a token without an organization is 409, a wrong method 405, and preflight passes', async () => {
    expect((await h.json('GET', '/api/organization')).status).toBe(401);
    expect((await h.json('GET', '/api/organization', undefined, h.bearer({ sub: ADMIN }))).status).toBe(409);
    expect((await h.json('DELETE', '/api/organization', undefined, bearer(ADMIN))).status).toBe(405);
    expect((await h.json('GET', '/api/organization/nothing', undefined, bearer(ADMIN))).status).toBe(404);
    expect((await fetch(`${h.base}/api/organization`, { method: 'OPTIONS' })).status).toBe(204);
  });
});

describe('the operator', () => {
  test('only OPERATOR_USER_ID is the operator, so a sign-in that claims the operator email gains nothing', async () => {
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
    const rows = ((await (await h.json('GET', '/api/admin/users', undefined, bearer(moved))).json()) as { users: { id: string; operator: boolean }[] }).users;
    expect(rows.filter((u) => u.operator).map((u) => u.id)).toEqual([moved]);
  });

  test('organizations in the operator pages come from Postgres', async () => {
    const listed = (await (await h.json('GET', '/api/admin/organizations', undefined, bearer(OPERATOR))).json()) as { organizations: { id: string; name: string; slug: string }[] };
    expect(listed.organizations.map((o) => [o.id, o.name, o.slug]).sort()).toEqual([
      ['org_01KELSEWHERE0000000000000', 'Elsewhere', 'elsewhere'],
      [ORG, 'Stage Labs', 'stage-labs'],
    ].sort());
  });
});
