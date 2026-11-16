import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import { accountId } from '../src/db/account-ids.ts';
import { addMember, rememberOrganization, removeMember } from '../src/db/memberships.ts';
import { memberships, organizations, users } from '../src/db/schema.ts';
import { ADMIN, claimsOf, claimsOfToken, harness, NOW, ORG, OTHER_ORG, type Harness, type TokenBody } from './metro-accounts-fixture.ts';
import { PGLITE_START_MS, PGLITE_STEP_MS } from './pglite-db.ts';

const MCI = 'org_01KMCIGROUP000000000000000';
const TWIN = 'org_01KAAAAAAAAAAAAAAAAAAAAAAA';

let h: Harness;
let ana = '';

beforeAll(async () => {
  h = await harness('metro');
}, PGLITE_START_MS);

beforeEach(async () => {
  await h.seed();
  h.clock.now = NOW;
  h.setMode('metro');
  await h.held.db.insert(organizations).values({ id: MCI, slug: 'mci-group', name: 'MCI Group', createdAt: 'x', updatedAt: 'x' });
  await h.held.db.insert(memberships).values({ id: accountId('om', NOW - 999), organization: OTHER_ORG, userId: ADMIN, role: 'admin', createdAt: NOW - 1000, updatedAt: NOW - 1000 });
  ana = (await addMember(h.held.db, { organization: ORG, email: 'ana@example.com', role: 'member', by: ADMIN, now: NOW })).user;
}, PGLITE_STEP_MS);

afterAll(async () => {
  await h.close();
});

const signIn = (): Promise<TokenBody> => h.tokens('google', claimsOf('google'));

const lastOf = async (): Promise<string | null> => (await h.held.db.select({ last: users.lastOrganization }).from(users).where(eq(users.id, ana)))[0]?.last ?? null;

async function join(organization: string, at = NOW): Promise<void> {
  await h.held.db.insert(memberships).values({ id: accountId('om', at), organization, userId: ana, role: 'member', createdAt: at, updatedAt: at });
}

async function body(res: Response): Promise<TokenBody> {
  expect(res.status).toBe(200);
  return (await res.json()) as TokenBody;
}

const refresh = (refreshToken: string, organization?: string): Promise<Response> => h.json('POST', '/api/auth/refresh', { refreshToken, ...(organization === undefined ? {} : { organization }) });

const switchTo = (t: TokenBody, organization: string): Promise<Response> => h.json('POST', '/api/auth/switch', { organization, refreshToken: t.refreshToken }, t.accessToken);

const addAgain = (organization: string): ReturnType<typeof addMember> => addMember(h.held.db, { organization, email: 'ana@example.com', role: 'admin', by: ADMIN, now: (h.clock.now += 1000) });

describe('where a sign-in lands', () => {
  test('memberships made at the same moment are told apart by organization name, then id, never by chance', async () => {
    await join(MCI);
    expect((await signIn()).organization).toBe(MCI);
    await h.held.db.update(users).set({ lastOrganization: null }).where(eq(users.id, ana));
    await h.held.db.insert(organizations).values({ id: TWIN, slug: 'mci-twin', name: 'mci group', createdAt: 'x', updatedAt: 'x' });
    await join(TWIN);
    expect((await signIn()).organization).toBe(TWIN);
  });

  test('a sign-in lands in the organization the person last chose while they are still in it', async () => {
    await join(MCI);
    const first = await signIn();
    expect(first.organization).toBe(MCI);
    expect(await lastOf()).toBe(MCI);
    await body(await switchTo(first, ORG));
    expect(await lastOf()).toBe(ORG);
    const again = await signIn();
    expect(again.organization).toBe(ORG);
    expect(claimsOfToken(again.accessToken)).toMatchObject({ org_id: ORG, role: 'member' });
  });

  test('a refresh and a switch the page marks as not chosen (the dashboard reading every organization) change nothing, a new organization does', async () => {
    await join(OTHER_ORG, NOW + 5);
    const first = await signIn();
    expect(first.organization).toBe(ORG);
    const refreshed = await body(await refresh(first.refreshToken, OTHER_ORG));
    expect(refreshed.organization).toBe(OTHER_ORG);
    expect(await lastOf()).toBe(ORG);
    const read = await body(await h.json('POST', '/api/auth/switch', { organization: OTHER_ORG, refreshToken: refreshed.refreshToken, remember: false }, first.accessToken));
    expect(read.organization).toBe(OTHER_ORG);
    expect(await lastOf()).toBe(ORG);
    expect((await signIn()).organization).toBe(ORG);
    await h.deps.users.setStatus(ana, 'approved');
    const made = await body(await h.json('POST', '/api/auth/organization', { name: 'Ana Co', refreshToken: read.refreshToken }, read.accessToken));
    expect(await lastOf()).toBe(made.organization);
    expect((await body(await refresh(made.refreshToken))).organization).toBeNull();
    expect(await lastOf()).toBe(made.organization);
    expect((await signIn()).organization).toBe(made.organization);
  });

  test('an organization that adds the person later never becomes where they land, even one they had chosen before being removed', async () => {
    expect((await signIn()).organization).toBe(ORG);
    await addAgain(OTHER_ORG);
    expect(await lastOf()).toBe(ORG);
    const second = await signIn();
    expect(second.organization).toBe(ORG);
    await body(await switchTo(second, OTHER_ORG));
    expect(await lastOf()).toBe(OTHER_ORG);
    await removeMember(h.held.db, { organization: OTHER_ORG, user: ana, by: ADMIN });
    expect(await lastOf()).toBeNull();
    await addAgain(OTHER_ORG);
    expect((await signIn()).organization).toBe(ORG);
  });

  test('a choice the person is no longer a member of is ignored, and the oldest membership is where they land', async () => {
    await join(OTHER_ORG, NOW + 5);
    await body(await switchTo(await signIn(), OTHER_ORG));
    expect((await signIn()).organization).toBe(OTHER_ORG);
    await h.held.db.delete(memberships).where(and(eq(memberships.organization, OTHER_ORG), eq(memberships.userId, ana)));
    expect(await lastOf()).toBe(OTHER_ORG);
    expect((await signIn()).organization).toBe(ORG);
    expect(await lastOf()).toBe(ORG);
  });

  test('only a member at that moment is remembered, and nothing is written with WorkOS', async () => {
    await rememberOrganization(h.held.db, ana, OTHER_ORG);
    expect(await lastOf()).toBeNull();
    const first = await signIn();
    expect((await switchTo(first, OTHER_ORG)).status).toBe(404);
    expect(await lastOf()).toBe(ORG);
    await h.held.db.update(users).set({ lastOrganization: null }).where(eq(users.id, ana));
    h.setMode('workos');
    h.workos.organizations.push(ORG);
    try {
      await body(await refresh(first.refreshToken, ORG));
      expect(await lastOf()).toBeNull();
    } finally {
      h.workos.organizations.splice(0);
    }
  });
});
