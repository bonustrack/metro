import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { accountId, ULID_RE } from '../src/db/account-ids.ts';
import { linkIdentity, type SignIn } from '../src/db/identities.ts';
import { addMember, isMemberRole, membersOf, organizationsOf, removeMember, setMemberRole } from '../src/db/memberships.ts';
import { identities, memberships, organizations, users } from '../src/db/schema.ts';
import { PGLITE_START_MS, PGLITE_STEP_MS, testDb, type TestDb } from './pglite-db.ts';

const NOW = Date.parse('2026-11-16T09:00:00.000Z');
const ORG = 'org_01STAGELABS000';
const OTHER = 'org_01ELSEWHERE000';
const ADMIN = 'user_01ADMIN';
const GOOGLE_SUB = '104857600000000000001';
const MSA = '9188040d-6c67-4c5b-b112-36a304b66dad:00000000-0000-0000-66f3-3332eca7ea81';

let held: TestDb;

async function seed(): Promise<void> {
  await held.db.insert(organizations).values([
    { id: ORG, slug: 'stage-labs', name: 'Stage Labs', createdAt: 'x', updatedAt: 'x' },
    { id: OTHER, slug: 'elsewhere', name: 'Elsewhere', createdAt: 'x', updatedAt: 'x' },
  ]);
  await held.db.insert(users).values({ id: ADMIN, email: 'admin@stage.box', updatedAt: 'x' });
  await held.db.insert(memberships).values({ id: accountId('om', NOW), organization: ORG, userId: ADMIN, role: 'admin', createdAt: NOW, updatedAt: NOW });
}

let clock = NOW;

const add = (email: string, role: 'admin' | 'member' = 'member', by = ADMIN): ReturnType<typeof addMember> => addMember(held.db, { organization: ORG, email, role, by, now: (clock += 1) });

const signIn = (input: Partial<SignIn>): SignIn => ({ provider: 'google', subject: GOOGLE_SUB, email: 'ana@example.com', emailProven: true, now: NOW, ...input });

beforeAll(async () => {
  held = await testDb();
}, PGLITE_START_MS);

beforeEach(async () => {
  clock = NOW;
  await held.reset();
  await seed();
}, PGLITE_STEP_MS);

afterAll(async () => {
  await held.close();
});

test('account ids are a prefix and a 26-character ULID that sorts by time', () => {
  const early = accountId('om', NOW);
  const late = accountId('om', NOW + 1);
  expect(early).toMatch(/^om_[0-9A-HJKMNP-TV-Z]{26}$/);
  expect(ULID_RE.test(accountId('user').slice('user_'.length))).toBe(true);
  expect(early.slice(0, 13) < late.slice(0, 13)).toBe(true);
  expect(accountId('session', 0).slice(0, 18)).toBe('session_0000000000');
  expect(isMemberRole('admin') && isMemberRole('member') && !isMemberRole('owner')).toBe(true);
});

describe('memberships', () => {
  test('an admin adds a person by email; a new email makes the user row, a known one reuses it', async () => {
    const added = await add('  Ana@Example.com ');
    expect(added.createdUser).toBe(true);
    expect(added.user).toMatch(/^user_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(added.id).toMatch(/^om_/);
    const row = (await held.db.select().from(users).where(eq(users.id, added.user)))[0];
    expect(row?.email).toBe('ana@example.com');
    const again = await addMember(held.db, { organization: OTHER, email: 'ana@example.com', role: 'member', by: ADMIN, now: NOW }).catch((err: unknown) => err);
    expect(again).toMatchObject({ status: 403 });
    await held.db.insert(memberships).values({ id: accountId('om'), organization: OTHER, userId: ADMIN, role: 'admin', createdAt: NOW, updatedAt: NOW });
    const elsewhere = await addMember(held.db, { organization: OTHER, email: 'ANA@example.com', role: 'admin', by: ADMIN, now: NOW });
    expect(elsewhere).toMatchObject({ user: added.user, createdUser: false });
    expect(await organizationsOf(held.db, added.user)).toEqual([
      { id: OTHER, slug: 'elsewhere', name: 'Elsewhere', role: 'admin' },
      { id: ORG, slug: 'stage-labs', name: 'Stage Labs', role: 'member' },
    ]);
  });

  test('adding is refused for a member twice, a bad address, a member who is not admin and an unknown organization', async () => {
    const ana = await add('ana@example.com');
    await expect(add('ana@example.com')).rejects.toMatchObject({ status: 409 });
    await expect(add('not an address')).rejects.toMatchObject({ status: 400 });
    await expect(add('bo@example.com', 'member', ana.user)).rejects.toMatchObject({ status: 403 });
    await expect(addMember(held.db, { organization: 'org_01NOSUCHORG00', email: 'bo@example.com', role: 'member', by: ADMIN, now: NOW })).rejects.toMatchObject({ status: 404 });
    expect((await membersOf(held.db, ORG)).map((m) => m.email)).toEqual(['admin@stage.box', 'ana@example.com']);
  });

  test('roles change, but never your own admin role and never the last admin', async () => {
    const ana = await add('ana@example.com');
    await expect(setMemberRole(held.db, { organization: ORG, user: ADMIN, role: 'member', by: ADMIN, now: NOW })).rejects.toMatchObject({ status: 400, message: 'you cannot take your own admin role away' });
    await setMemberRole(held.db, { organization: ORG, user: ana.user, role: 'admin', by: ADMIN, now: NOW + 1 });
    await setMemberRole(held.db, { organization: ORG, user: ADMIN, role: 'member', by: ana.user, now: NOW + 2 });
    await expect(setMemberRole(held.db, { organization: ORG, user: ana.user, role: 'member', by: ADMIN, now: NOW })).rejects.toMatchObject({ status: 403 });
    const listed = await membersOf(held.db, ORG);
    expect(listed.map((m) => [m.email, m.role])).toEqual([['admin@stage.box', 'member'], ['ana@example.com', 'admin']]);
    await expect(setMemberRole(held.db, { organization: ORG, user: 'user_01NOBODY', role: 'admin', by: ana.user, now: NOW })).rejects.toMatchObject({ status: 404 });
  });

  test('removing refuses yourself and the last admin, and takes the membership only', async () => {
    const ana = await add('ana@example.com', 'admin');
    const bo = await add('bo@example.com');
    await expect(removeMember(held.db, { organization: ORG, user: ADMIN, by: ADMIN })).rejects.toMatchObject({ status: 400, message: 'you cannot remove yourself' });
    await removeMember(held.db, { organization: ORG, user: bo.user, by: ana.user });
    await removeMember(held.db, { organization: ORG, user: ADMIN, by: ana.user });
    await held.db.insert(memberships).values({ id: accountId('om'), organization: ORG, userId: bo.user, role: 'admin', createdAt: NOW + 10, updatedAt: NOW + 10 });
    await setMemberRole(held.db, { organization: ORG, user: bo.user, role: 'member', by: ana.user, now: NOW });
    await expect(removeMember(held.db, { organization: ORG, user: ana.user, by: bo.user })).rejects.toMatchObject({ status: 403 });
    expect((await membersOf(held.db, ORG)).map((m) => m.user)).toEqual([ana.user, bo.user]);
    expect((await held.db.select().from(users).where(eq(users.id, ADMIN))).length).toBe(1);
  });

  test('two admins demoting each other at once leave one admin', async () => {
    const ana = await add('ana@example.com', 'admin');
    const results = await Promise.allSettled([
      setMemberRole(held.db, { organization: ORG, user: ana.user, role: 'member', by: ADMIN, now: NOW }),
      setMemberRole(held.db, { organization: ORG, user: ADMIN, role: 'member', by: ana.user, now: NOW }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled').length).toBe(1);
    expect((await membersOf(held.db, ORG)).filter((m) => m.role === 'admin').length).toBe(1);
  });
});

describe('identities', () => {
  test('a first sign-in with a proven new email makes the user, the next one finds it by its subject', async () => {
    const first = await linkIdentity(held.db, signIn({}));
    expect(first.kind).toBe('created');
    const next = await linkIdentity(held.db, signIn({ email: 'changed@example.com', now: NOW + 5 }));
    expect(next).toEqual({ user: first.user, kind: 'known' });
    const rows = await held.db.select().from(identities);
    expect(rows).toEqual([{ provider: 'google', subject: GOOGLE_SUB, userId: first.user, email: 'ana@example.com', createdAt: NOW, lastUsedAt: NOW + 5 }]);
  });

  test('a member added by email is linked at the first sign-in, from either provider', async () => {
    const ana = await add('ana@example.com');
    expect(await linkIdentity(held.db, signIn({ email: 'Ana@Example.com' }))).toEqual({ user: ana.user, kind: 'linked' });
    expect(await linkIdentity(held.db, signIn({ provider: 'microsoft', subject: MSA }))).toEqual({ user: ana.user, kind: 'linked' });
    expect((await held.db.select().from(identities)).length).toBe(2);
  });

  test('an unproven email links nothing, and nothing is created', async () => {
    await add('ana@example.com');
    await expect(linkIdentity(held.db, signIn({ emailProven: false }))).rejects.toMatchObject({ status: 403 });
    await expect(linkIdentity(held.db, signIn({ email: null }))).rejects.toMatchObject({ status: 403 });
    expect(await held.db.select().from(identities)).toEqual([]);
  });

  test('two existing users are never merged: a known subject keeps its user, a second account of the same provider is refused', async () => {
    const ana = await add('ana@example.com');
    const bo = await add('bo@example.com');
    await linkIdentity(held.db, signIn({}));
    expect(await linkIdentity(held.db, signIn({ email: 'bo@example.com' }))).toEqual({ user: ana.user, kind: 'known' });
    await expect(linkIdentity(held.db, signIn({ subject: '104857600000000000002' }))).rejects.toMatchObject({ status: 409 });
    expect(await linkIdentity(held.db, signIn({ subject: '104857600000000000003', email: 'bo@example.com' }))).toEqual({ user: bo.user, kind: 'linked' });
    expect((await held.db.select().from(users)).length).toBe(3);
  });

  test('a subject that does not have the provider shape is refused', async () => {
    await expect(linkIdentity(held.db, signIn({ provider: 'microsoft', subject: 'not-a-tenant' }))).rejects.toMatchObject({ status: 400 });
    await expect(linkIdentity(held.db, signIn({ subject: 'has space' }))).rejects.toMatchObject({ status: 400 });
  });
});
