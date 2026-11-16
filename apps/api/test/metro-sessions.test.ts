import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { sessionClaims } from '../../../packages/http/test/workos-fixture.ts';
import { accountId } from '../src/db/account-ids.ts';
import { addMember } from '../src/db/memberships.ts';
import { authSessions, memberships, users } from '../src/db/schema.ts';
import { ADMIN, claimsOf, claimsOfToken, harness, NOW, ORG, OTHER_ORG, type Harness, type TokenBody } from './metro-accounts-fixture.ts';
import { PGLITE_START_MS, PGLITE_STEP_MS } from './pglite-db.ts';

let h: Harness;
let carla = '';

beforeAll(async () => {
  h = await harness('metro');
}, PGLITE_START_MS);

beforeEach(async () => {
  await h.seed();
  h.clock.now = NOW;
  h.setMode('metro');
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

async function workosCarla(token: string, inOrganizations: string[]): Promise<void> {
  h.workos.users.push({ id: carla, email: 'carla@example.com', first_name: 'Carla', last_name: 'Dias', profile_picture_url: null, created_at: '2026-10-01T00:00:00.000Z' });
  h.workos.holders.set(token, carla);
  await h.held.db.insert(users).values({ id: carla, email: 'carla@example.com', name: 'Carla Dias', updatedAt: 'x' }).onConflictDoNothing();
  for (const organization of inOrganizations) await h.held.db.insert(memberships).values({ id: accountId('om', NOW), organization, userId: carla, role: 'member', createdAt: NOW, updatedAt: NOW });
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
    const stranger = h.workos.issuer.mint(sessionClaims({ sub: ADMIN, org_id: OTHER_ORG, role: 'admin' }));
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

describe('moving WorkOS sessions to Metro without a new sign-in', () => {
  test('an old WorkOS refresh token is exchanged once for a Metro session of the same person', async () => {
    await workosCarla('rt_carla_0000000001', [ORG]);
    const moved = await body(await refresh('rt_carla_0000000001', ORG));
    expect(moved.refreshToken).toMatch(/^mrt_/);
    expect(moved.user).toMatchObject({ id: carla, email: 'carla@example.com', name: 'Carla Dias' });
    expect(claimsOfToken(moved.accessToken)).toMatchObject({ iss: 'https://api.metro.box', sub: carla, org_id: ORG, role: 'member' });
    expect((await h.held.db.select().from(authSessions)).map((s) => [s.userId, s.method])).toEqual([[carla, 'workos']]);
    expect((await refresh(moved.refreshToken, ORG)).status).toBe(200);
    expect((await refresh('rt_dead_000000000001', ORG)).status).toBe(401);
  });

  test('only a WorkOS-shaped token goes to WorkOS, the exchange is rate limited per address, and an unverified WorkOS email is never kept', async () => {
    const sent = (): number => h.workos.calls.filter((c) => c.path === '/user_management/authenticate').length;
    const before = sent();
    expect((await refresh('short', ORG)).status).toBe(401);
    expect((await refresh('has spaces in it 0000', ORG)).status).toBe(401);
    expect(sent()).toBe(before);
    for (let i = 0; i < 20; i += 1) expect((await refresh(`rt_dead_${String(i).padStart(12, '0')}`, ORG, '198.51.100.40')).status).toBe(401);
    expect((await refresh('rt_dead_999999999999', ORG, '198.51.100.40')).status).toBe(429);
    expect(sent()).toBe(before + 20);
    const eve = accountId('user', NOW + 3);
    h.workos.users.push({ id: eve, email: 'ceo@anderra.ch', first_name: 'Eve', last_name: null, profile_picture_url: null, created_at: '2026-10-01T00:00:00.000Z', email_verified: false });
    h.workos.holders.set('rt_eve_000000000001', eve);
    expect((await refresh('rt_eve_000000000001')).status).toBe(401);
    expect((await h.held.db.select().from(users).where(eq(users.id, eve)))[0]).toMatchObject({ email: null, name: 'Eve' });
    const finn = accountId('user', NOW + 4);
    h.workos.users.push({ id: finn, email: 'finn@example.com', first_name: 'Finn', last_name: null, profile_picture_url: null, created_at: '2026-10-01T00:00:00.000Z', email_verified: true });
    h.workos.holders.set('rt_finn_00000000001', finn);
    expect((await refresh('rt_finn_00000000001')).status).toBe(401);
    expect((await h.held.db.select().from(users).where(eq(users.id, finn)))[0]?.email).toBe('finn@example.com');
  });

  test('switch and create also take a WorkOS refresh token with a WorkOS bearer', async () => {
    await workosCarla('rt_carla_switch_0001', [ORG, OTHER_ORG]);
    const bearer = h.workos.issuer.mint(sessionClaims({ sub: carla, org_id: ORG, role: 'member' }));
    const switched = await body(await h.json('POST', '/api/auth/switch', { organization: OTHER_ORG, refreshToken: 'rt_carla_switch_0001' }, bearer));
    expect(switched).toMatchObject({ organization: OTHER_ORG, user: { id: carla } });
    expect(switched.refreshToken).toMatch(/^mrt_/);
    h.workos.holders.set('rt_carla_create_0001', carla);
    await h.deps.users.setStatus(carla, 'approved');
    const made = await body(await h.json('POST', '/api/auth/organization', { name: 'Carla Co', refreshToken: 'rt_carla_create_0001' }, bearer));
    expect(made).toMatchObject({ organizationName: 'Carla Co', user: { id: carla } });
    expect(h.workos.calls.some((c) => c.path === '/organizations')).toBe(false);
  });
});

describe('the same routes in both modes', () => {
  test('/api/mode says which accounts and buttons, and the login takes GitHub only with WorkOS', async () => {
    expect(await (await h.json('GET', '/api/mode')).json()).toMatchObject({ mode: 'hosted', accounts: 'metro', providers: ['google', 'microsoft'] });
    expect((await h.start('github')).status).toBe(400);
    h.setMode('workos');
    expect(await (await h.json('GET', '/api/mode')).json()).toMatchObject({ accounts: 'workos', providers: ['google', 'microsoft', 'github'] });
    const toWorkos = await h.start('github');
    expect(toWorkos.status).toBe(302);
    expect(new URL(toWorkos.headers.get('location') ?? '').searchParams.get('provider')).toBe('GitHubOAuth');
  });

  test('with WorkOS and no WorkOS settings, the callback still answers 503 as before', async () => {
    h.setMode('workos');
    const keep = h.deps.config;
    try {
      const state = new URL((await h.start('google')).headers.get('location') ?? '').searchParams.get('state') ?? '';
      h.deps.config = () => null;
      expect((await fetch(`${h.base}/api/auth/callback?code=x&state=${state}`, { redirect: 'manual' })).status).toBe(503);
    } finally {
      h.deps.config = keep;
    }
  });

  test('with WorkOS, a WorkOS refresh stays with WorkOS and a Metro one still rotates, checked against WorkOS memberships', async () => {
    const metro = await signedInAna();
    h.setMode('workos');
    h.workos.organizations.push(ORG);
    try {
      h.workos.holders.set('rt_workos_only', ADMIN);
      const fromWorkos = await body(await refresh('rt_workos_only', ORG));
      expect(fromWorkos.refreshToken).not.toMatch(/^mrt_/);
      expect(claimsOfToken(fromWorkos.accessToken).iss).toBe('https://api.workos.com');
      const rotated = await body(await refresh(metro.refreshToken, ORG));
      expect(rotated.refreshToken).toMatch(/^mrt_/);
      expect(claimsOfToken(rotated.accessToken)).toMatchObject({ iss: 'https://api.metro.box', org_id: ORG, role: 'admin' });
    } finally {
      h.workos.organizations.splice(0);
    }
  });
});
