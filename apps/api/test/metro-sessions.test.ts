import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { accountId } from '../src/db/account-ids.ts';
import { addMember } from '../src/db/memberships.ts';
import { authSessions, memberships, users } from '../src/db/schema.ts';
import { ADMIN, claimsOf, claimsOfToken, harness, NOW, ORG, OTHER_ORG, type Harness, type TokenBody } from './metro-accounts-fixture.ts';
import { PGLITE_START_MS, PGLITE_STEP_MS } from './pglite-db.ts';

let h: Harness;
let carla = '';

beforeAll(async () => {
  h = await harness();
}, PGLITE_START_MS);

beforeEach(async () => {
  await h.seed();
  h.clock.now = NOW;
  carla = accountId('user', NOW);
}, PGLITE_STEP_MS);

afterAll(async () => {
  await h.close();
});

const refresh = (refreshToken: string, organization?: string, address = '192.0.2.50'): Promise<Response> => h.json('POST', '/api/auth/refresh', { refreshToken, ...(organization === undefined ? {} : { organization }) }, undefined, { 'fly-client-ip': address });

const body = async (res: Response): Promise<TokenBody> => {
  expect(res.status).toBe(200);
  return (await res.json()) as TokenBody;
};

async function signedInAna(): Promise<TokenBody> {
  await addMember(h.held.db, { organization: ORG, email: 'ana@example.com', role: 'member', by: ADMIN, now: NOW });
  return h.tokens('google', claimsOf('google'));
}

describe('Metro refresh tokens', () => {
  test('each refresh rotates the token; the previous one still works for 60 seconds, and its reuse after that ends the whole session', async () => {
    const first = await signedInAna();
    const second = await body(await refresh(first.refreshToken, ORG));
    expect(second.refreshToken).toMatch(/^mrt_/);
    expect(second.refreshToken).not.toBe(first.refreshToken);
    expect(claimsOfToken(second.accessToken)).toMatchObject({ sub: first.user.id, org_id: ORG, role: 'member', sid: claimsOfToken(first.accessToken).sid });
    const third = await body(await refresh(first.refreshToken, ORG));
    expect(third.refreshToken).not.toBe(second.refreshToken);
    const fourth = await body(await refresh(third.refreshToken, ORG));
    h.clock.now += 61_000;
    expect((await refresh(third.refreshToken, ORG)).status).toBe(401);
    expect((await refresh(fourth.refreshToken, ORG)).status).toBe(401);
    expect((await h.held.db.select().from(authSessions))[0]?.revokedAt).toBe(h.clock.now);
  });

  test('refresh reuse: a token replaced two rotations ago still ends the whole session when it comes back', async () => {
    const first = await signedInAna();
    const second = await body(await refresh(first.refreshToken, ORG));
    h.clock.now += 61_000;
    const third = await body(await refresh(second.refreshToken, ORG));
    h.clock.now += 61_000;
    await body(await refresh(third.refreshToken, ORG));
    expect((await refresh(first.refreshToken, ORG)).status).toBe(401);
    expect((await h.held.db.select().from(authSessions))[0]?.revokedAt).toBe(h.clock.now);
  });

  test('a refresh without an organization answers none, an organization the person is not in ends the session, and so does a rejected account', async () => {
    const first = await signedInAna();
    expect((await refresh(first.refreshToken, OTHER_ORG)).status).toBe(401);
    const second = await h.tokens('google', claimsOf('google'));
    expect((await refresh(second.refreshToken)).status).toBe(401);
    const third = await h.tokens('google', claimsOf('google'));
    await h.deps.users.setStatus(third.user.id, 'approved');
    const bare = await body(await refresh(third.refreshToken));
    expect(bare.organization).toBeNull();
    expect(claimsOfToken(bare.accessToken).org_id).toBeUndefined();
    await h.deps.users.setStatus(third.user.id, 'rejected');
    expect((await refresh(bare.refreshToken, ORG)).status).toBe(401);
    expect((await refresh('mrt_nope', ORG)).status).toBe(401);
    expect((await refresh('', ORG)).status).toBe(400);
  });

  test('sign-out revokes the session, so its refresh token stops working', async () => {
    const first = await signedInAna();
    expect((await h.json('POST', '/api/auth/logout', {}, first.accessToken)).status).toBe(200);
    expect((await refresh(first.refreshToken, ORG)).status).toBe(401);
    expect((await h.held.db.select().from(authSessions))[0]?.revokedAt).not.toBeNull();
  });
});

describe('organizations from Postgres', () => {
  test('a switch mints for another organization only after a membership check, with the role held there', async () => {
    const first = await signedInAna();
    expect((await h.json('POST', '/api/auth/switch', { organization: OTHER_ORG, refreshToken: first.refreshToken }, first.accessToken)).status).toBe(404);
    await h.held.db.insert(memberships).values({ id: accountId('om', NOW), organization: OTHER_ORG, userId: first.user.id, role: 'admin', createdAt: NOW, updatedAt: NOW });
    const listed = (await (await h.json('GET', '/api/auth/organizations', undefined, first.accessToken)).json()) as { organizations: { id: string; role: string; slug: string }[] };
    expect(listed.organizations.map((o) => [o.id, o.role, o.slug])).toEqual([[OTHER_ORG, 'admin', 'elsewhere'], [ORG, 'member', 'stage-labs']]);
    const switched = await body(await h.json('POST', '/api/auth/switch', { organization: OTHER_ORG, refreshToken: first.refreshToken }, first.accessToken));
    expect(switched).toMatchObject({ organization: OTHER_ORG, organizationName: 'Elsewhere', organizationSlug: 'elsewhere' });
    expect(claimsOfToken(switched.accessToken)).toMatchObject({ org_id: OTHER_ORG, role: 'admin' });
    const stranger = h.bearer({ sub: ADMIN, org_id: OTHER_ORG, role: 'admin' });
    await h.held.db.insert(memberships).values({ id: accountId('om', NOW + 1), organization: OTHER_ORG, userId: ADMIN, role: 'admin', createdAt: NOW, updatedAt: NOW });
    expect((await h.json('POST', '/api/auth/switch', { organization: OTHER_ORG, refreshToken: switched.refreshToken }, stranger)).status).toBe(401);
  });

  test('an approved person creates an organization with an org_ ULID id, a slug from its name, and is its admin', async () => {
    const first = await signedInAna();
    expect((await h.json('POST', '/api/auth/organization', { name: 'New Co', refreshToken: first.refreshToken }, first.accessToken)).status).toBe(403);
    await h.deps.users.setStatus(first.user.id, 'approved');
    const made = await body(await h.json('POST', '/api/auth/organization', { name: 'New Co', refreshToken: first.refreshToken }, first.accessToken));
    expect(made.organization).toMatch(/^org_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(made).toMatchObject({ organizationName: 'New Co', organizationSlug: 'new-co' });
    expect(claimsOfToken(made.accessToken)).toMatchObject({ org_id: made.organization, role: 'admin' });
    const rows = await h.held.db.select().from(memberships).where(eq(memberships.organization, made.organization ?? ''));
    expect(rows.map((r) => [r.userId, r.role])).toEqual([[first.user.id, 'admin']]);
  });
});

describe('a refresh token Metro did not make', () => {
  test('an old WorkOS refresh token, or any token without mrt_, is refused like an unknown one and starts no session', async () => {
    await h.held.db.insert(users).values({ id: carla, email: 'carla@example.com', name: 'Carla Dias', updatedAt: 'x' });
    await h.held.db.insert(memberships).values({ id: accountId('om', NOW), organization: ORG, userId: carla, role: 'member', createdAt: NOW, updatedAt: NOW });
    for (const token of ['rt_carla_0000000001', 'Ab+/=!~.wos~refresh~token~shape~0001', 'short']) {
      const refused = await refresh(token, ORG);
      expect(refused.status).toBe(401);
      expect(await refused.json()).toEqual({ error: 'the session has ended, sign in again' });
    }
    const bearer = h.bearer({ sub: carla, org_id: ORG, role: 'member' });
    expect((await h.json('POST', '/api/auth/switch', { organization: ORG, refreshToken: 'rt_carla_switch_0001' }, bearer)).status).toBe(401);
    expect(await h.held.db.select().from(authSessions)).toEqual([]);
  });
});

describe('the routes the page reads', () => {
  test('/api/mode says which accounts and buttons, and the login takes no GitHub', async () => {
    expect(await (await h.json('GET', '/api/mode')).json()).toMatchObject({ mode: 'hosted', accounts: 'metro', providers: ['google', 'microsoft'] });
    expect((await h.start('github')).status).toBe(400);
  });
});
