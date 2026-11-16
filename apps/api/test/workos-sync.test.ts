import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { asc } from 'drizzle-orm';
import type { WorkosConfig } from '../src/auth/workos.ts';
import { accountId } from '../src/db/account-ids.ts';
import { identities, memberships, organizations, users } from '../src/db/schema.ts';
import { reportLines } from '../src/workos-sync/report.ts';
import { runWorkosSync, syncWorkos } from '../src/workos-sync/run.ts';
import { microsoftSubject, readWorkos } from '../src/workos-sync/snapshot.ts';
import { PGLITE_START_MS, PGLITE_STEP_MS, testDb, type TestDb } from './pglite-db.ts';
import { fakeWorkos, type FakeWorkos } from './workos-fake.ts';

const NOW = Date.parse('2026-11-16T09:00:00.000Z');
const STAGE = 'org_01STAGELABS000';
const FRESH = 'org_01FRESHORG0000';
const GONE = 'org_01GONEORG00000';
const MSA = '9188040d-6c67-4c5b-b112-36a304b66dad';
const AT = '2026-09-01T10:00:00.000Z';

let fake: FakeWorkos;
let held: TestDb;
let cfg: WorkosConfig;

function workosState(): void {
  fake.organizations.splice(0, fake.organizations.length, STAGE, FRESH);
  fake.names.set(STAGE, 'Stage Labs').set(FRESH, 'Fresh Org');
  fake.users.push(
    { id: 'user_03CAROL', email: 'carol@example.com', first_name: 'Carol', last_name: null, profile_picture_url: null, created_at: AT },
    { id: 'user_04DAN', email: 'dan@example.com', first_name: 'Dan', last_name: null, profile_picture_url: null, created_at: AT },
    { id: 'user_05EVE', email: 'eve@example.com', first_name: 'Eve', last_name: null, profile_picture_url: null, created_at: AT },
    { id: 'user_06HAL', email: 'hal@example.com', first_name: 'Hal', last_name: null, profile_picture_url: null, created_at: AT },
  );
  fake.members.splice(
    0,
    fake.members.length,
    { id: 'om_1', user_id: 'user_01ABC', role: 'admin', organization_id: STAGE },
    { id: 'om_2', user_id: 'user_02BOB', role: 'member', organization_id: STAGE },
    { id: 'om_3', user_id: 'user_03CAROL', role: 'admin', organization_id: STAGE },
    { id: 'om_4', user_id: 'user_03CAROL', role: 'admin', organization_id: FRESH },
    { id: 'om_5', user_id: 'user_04DAN', role: 'billing', organization_id: FRESH },
    { id: 'om_6', user_id: 'user_06HAL', role: 'member', organization_id: FRESH, status: 'inactive' },
  );
  fake.invitations.push(
    { id: 'inv_1', email: 'Fay@Example.com', state: 'pending', role_slug: 'member', organization_id: STAGE },
    { id: 'inv_2', email: 'bob@stage.box', state: 'pending', role_slug: 'admin', organization_id: STAGE },
    { id: 'inv_3', email: 'gil@example.com', state: 'pending', role_slug: 'admin', organization_id: FRESH },
    { id: 'inv_4', email: 'held@example.com', state: 'pending', role_slug: null, organization_id: FRESH },
    { id: 'inv_5', email: 'old@example.com', state: 'accepted', role_slug: 'member', organization_id: STAGE },
  );
  fake.identities.set('user_01ABC', [{ idp_id: '1001', type: 'OAuth', provider: 'GoogleOAuth' }]);
  fake.identities.set('user_02BOB', [{ idp_id: '66F33332ECA7EA81', type: 'OAuth', provider: 'MicrosoftOAuth' }]);
  fake.identities.set('user_03CAROL', [
    { idp_id: '00000000-0000-0000-1234-56789ABCDEF0', type: 'OAuth', provider: 'MicrosoftOAuth' },
    { idp_id: '77', type: 'OAuth', provider: 'GitHubOAuth' },
  ]);
  fake.identities.set('user_04DAN', [{ idp_id: '88', type: 'OAuth', provider: 'GitHubOAuth' }]);
  fake.identities.set('user_06HAL', [{ idp_id: 'a3c3e1f2-1111-4222-8333-944455556666', type: 'OAuth', provider: 'MicrosoftOAuth' }]);
  fake.paging.size = 1;
}

async function metroState(): Promise<void> {
  await held.db.insert(organizations).values([
    { id: STAGE, slug: 'stage-labs', name: 'Old Name', createdAt: AT, updatedAt: AT },
    { id: GONE, slug: 'fresh-org', name: null, createdAt: AT, updatedAt: AT },
  ]);
  await held.db.insert(users).values([
    { id: 'user_01ABC', email: 'admin@stage.box', name: 'Stage Labs', picture: 'https://pic.example/a.png', createdAt: AT, updatedAt: AT },
    { id: 'user_02BOB', email: 'bob@old.example', name: 'Bob', createdAt: AT, updatedAt: AT },
    { id: 'user_09STALE', email: 'carol@example.com', updatedAt: AT },
    { id: 'user_08HELD', email: 'held@example.com', updatedAt: AT },
    { id: 'user_03CAROL', email: null, name: 'Carol', createdAt: AT, updatedAt: AT },
  ]);
  const member = (organization: string, userId: string, role: 'admin' | 'member') => ({ id: accountId('om'), organization, userId, role, createdAt: NOW, updatedAt: NOW });
  await held.db.insert(memberships).values([member(STAGE, 'user_01ABC', 'admin'), member(STAGE, 'user_03CAROL', 'member'), member(STAGE, 'user_09STALE', 'member'), member(GONE, 'user_02BOB', 'member')]);
  await held.db.insert(identities).values([
    { provider: 'google', subject: '1001', userId: 'user_01ABC', email: 'admin@stage.box', createdAt: NOW },
    { provider: 'microsoft', subject: `${MSA}:00000000-0000-0000-1234-56789abcdef0`, userId: 'user_09STALE', email: 'carol@example.com', createdAt: NOW },
  ]);
}

async function tables(): Promise<unknown> {
  return {
    organizations: await held.db.select({ id: organizations.id, slug: organizations.slug, name: organizations.name }).from(organizations).orderBy(asc(organizations.id)),
    users: await held.db.select({ id: users.id, email: users.email, name: users.name }).from(users).orderBy(asc(users.id)),
    memberships: await held.db.select({ organization: memberships.organization, user: memberships.userId, role: memberships.role }).from(memberships).orderBy(asc(memberships.organization), asc(memberships.userId)),
    identities: await held.db.select({ provider: identities.provider, subject: identities.subject, user: identities.userId }).from(identities).orderBy(asc(identities.subject)),
  };
}

beforeAll(async () => {
  held = await testDb();
}, PGLITE_START_MS);

beforeEach(async () => {
  await fake?.close();
  fake = await fakeWorkos();
  cfg = { apiKey: 'sk_test_fake', clientId: 'client_fake', base: fake.base };
  workosState();
  await held.reset();
  await metroState();
}, PGLITE_STEP_MS);

afterAll(async () => {
  await fake.close();
  await held.close();
});

describe('reading WorkOS', () => {
  test('every list is read page by page with after', async () => {
    const snapshot = await readWorkos(cfg);
    expect(snapshot.users.length).toBe(6);
    expect(snapshot.memberships.length).toBe(5);
    expect(snapshot.invitations.map((i) => i.email).sort()).toEqual(['Fay@Example.com', 'bob@stage.box', 'gil@example.com', 'held@example.com']);
    expect(fake.seen.some((line) => line.startsWith('GET /user_management/users?limit=100&after=user_01ABC'))).toBe(true);
    expect(fake.seen.some((line) => line.startsWith('GET /organizations?limit=100&after='))).toBe(true);
    expect(fake.seen.filter((line) => line.startsWith('GET /user_management/organization_memberships?organization_id=') && line.includes('&after=')).length).toBeGreaterThan(0);
  });

  test('Microsoft personal account ids become the consumer tenant and the object id', () => {
    expect(microsoftSubject('66F33332ECA7EA81')).toBe(`${MSA}:00000000-0000-0000-66f3-3332eca7ea81`);
    expect(microsoftSubject('00000000-0000-0000-66F3-3332ECA7EA81')).toBe(`${MSA}:00000000-0000-0000-66f3-3332eca7ea81`);
    expect(microsoftSubject('a3c3e1f2-1111-4222-8333-944455556666')).toBeNull();
    expect(microsoftSubject('not an id')).toBeNull();
  });
});

describe('the export', () => {
  test('a dry run writes nothing and prints every difference, the people who need another sign-in and the warnings', async () => {
    const before = await tables();
    const plan = await syncWorkos(held.db, await readWorkos(cfg), { apply: false, now: NOW });
    expect(await tables()).toEqual(before);
    const fay = plan.users.invited.find((i) => i.email === 'fay@example.com')?.id ?? '';
    const gil = plan.users.invited.find((i) => i.email === 'gil@example.com')?.id ?? '';
    const lines = reportLines(plan, false);
    expect(lines.slice(0, 6)).toEqual([
      'WorkOS export: dry run, nothing written. Run again with --apply to write.',
      'WorkOS: 2 organizations, 6 users, 5 active memberships, 4 pending invitations, 1 Google and 2 Microsoft sign-ins.',
      'Organizations: 1 added, 1 renamed, 1 only in Metro.',
      'Users: 3 added, 2 changed, 1 emails moved, 2 invited people added.',
      'Memberships: 6 added, 1 role changes, 2 removed.',
      'Identities: 1 added, 1 moved.',
    ]);
    expect(lines).toContain(`+ organization ${FRESH} "Fresh Org" with slug fresh-org-2`);
    expect(lines).toContain(`~ organization ${STAGE} name "Old Name" -> "Stage Labs"`);
    expect(lines).toContain('~ user user_02BOB: email "bob@old.example" -> "bob@stage.box"');
    expect(lines).toContain('~ user user_03CAROL: email (none) -> "carol@example.com"');
    expect(lines).toContain('~ email carol@example.com moves from user_09STALE to user_03CAROL');
    expect(lines).toContain(`+ invited person fay@example.com (${fay})`);
    expect(lines).toContain(`+ membership fay@example.com (${fay}) in ${STAGE}: member, from a pending invitation`);
    expect(lines).toContain(`+ membership gil@example.com (${gil}) in ${FRESH}: admin, from a pending invitation`);
    expect(lines).toContain(`+ membership held@example.com (user_08HELD) in ${FRESH}: member, from a pending invitation`);
    expect(lines).toContain(`+ membership bob@stage.box (user_02BOB) in ${STAGE}: member`);
    expect(lines).toContain(`~ membership carol@example.com (user_03CAROL) in ${STAGE}: member -> admin`);
    expect(lines).toContain(`- membership carol@example.com (user_09STALE) in ${STAGE}: member, WorkOS no longer has it`);
    expect(lines).toContain(`- membership bob@stage.box (user_02BOB) in ${GONE}: member, WorkOS no longer has it`);
    expect(lines).toContain(`+ microsoft sign-in ${MSA}:00000000-0000-0000-66f3-3332eca7ea81 for bob@stage.box (user_02BOB)`);
    expect(lines).toContain(`~ microsoft sign-in ${MSA}:00000000-0000-0000-1234-56789abcdef0 moves from user_09STALE to carol@example.com (user_03CAROL)`);
    expect(lines).toContain('Neither Google nor Microsoft (2: 1 GitHub, 1 email code only). They will need Google, Microsoft or a login link:');
    expect(lines).toContain('  dan@example.com (user_04DAN): github, member of 1 organizations');
    expect(lines).toContain('  eve@example.com (user_05EVE): email code only, member of 0 organizations');
    expect(lines).toContain(`  organization ${GONE} is not in WorkOS: it keeps its row, and its memberships go`);
    expect(lines).toContain(`  dan@example.com in ${FRESH}: the WorkOS role "billing" becomes member`);
    expect(lines).toContain('  the MicrosoftOAuth sign-in of hal@example.com has an id Metro cannot map (a3c3e1f2-1111-4222-8333-944455556666); it is left out');
  });

  test('--apply writes the plan in one transaction, and a second run finds nothing to change', async () => {
    const plan = await syncWorkos(held.db, await readWorkos(cfg), { apply: true, now: NOW });
    const fay = plan.users.invited.find((i) => i.email === 'fay@example.com')?.id ?? '';
    const gil = plan.users.invited.find((i) => i.email === 'gil@example.com')?.id ?? '';
    expect(fay).toMatch(/^user_[0-9A-HJKMNP-TV-Z]{26}$/);
    const after = (await tables()) as Record<string, unknown[]>;
    expect(after.organizations).toEqual([
      { id: FRESH, slug: 'fresh-org-2', name: 'Fresh Org' },
      { id: GONE, slug: 'fresh-org', name: null },
      { id: STAGE, slug: 'stage-labs', name: 'Stage Labs' },
    ]);
    const byKey = (a: { organization: string; user: string }, b: { organization: string; user: string }): number => (`${a.organization} ${a.user}` < `${b.organization} ${b.user}` ? -1 : 1);
    expect([...(after.memberships as { organization: string; user: string }[])].sort(byKey)).toEqual(
      [
        { organization: FRESH, user: 'user_03CAROL', role: 'admin' },
        { organization: FRESH, user: 'user_04DAN', role: 'member' },
        { organization: FRESH, user: 'user_08HELD', role: 'member' },
        { organization: FRESH, user: gil, role: 'admin' },
        { organization: STAGE, user: 'user_01ABC', role: 'admin' },
        { organization: STAGE, user: 'user_02BOB', role: 'member' },
        { organization: STAGE, user: 'user_03CAROL', role: 'admin' },
        { organization: STAGE, user: fay, role: 'member' },
      ].sort(byKey),
    );
    expect(after.identities).toEqual([
      { provider: 'google', subject: '1001', user: 'user_01ABC' },
      { provider: 'microsoft', subject: `${MSA}:00000000-0000-0000-1234-56789abcdef0`, user: 'user_03CAROL' },
      { provider: 'microsoft', subject: `${MSA}:00000000-0000-0000-66f3-3332eca7ea81`, user: 'user_02BOB' },
    ]);
    const emails = Object.fromEntries((after.users as { id: string; email: string | null }[]).map((u) => [u.id, u.email]));
    expect(emails).toMatchObject({ user_02BOB: 'bob@stage.box', user_03CAROL: 'carol@example.com', user_09STALE: null, user_08HELD: 'held@example.com', [fay]: 'fay@example.com' });
    const again = reportLines(await syncWorkos(held.db, await readWorkos(cfg), { apply: true, now: NOW + 1 }), true);
    expect(again).toContain('Metro already matches WorkOS.');
    expect(again).toContain('Memberships: 0 added, 0 role changes, 0 removed.');
  });

  test('a failure in the last write rolls every earlier write back, and two WorkOS users with one email stop the export', async () => {
    fake.users.push({ id: 'user_07LONG', email: `${'x'.repeat(250)}@example.com`, first_name: 'Long', last_name: null, profile_picture_url: null, created_at: AT });
    fake.identities.set('user_07LONG', [{ idp_id: '2002', type: 'OAuth', provider: 'GoogleOAuth' }]);
    const before = await tables();
    await expect(syncWorkos(held.db, await readWorkos(cfg), { apply: true, now: NOW })).rejects.toThrow();
    expect(await tables()).toEqual(before);
    fake.users.pop();
    fake.users.push({ id: 'user_07TWIN', email: 'CAROL@example.com', first_name: 'Twin', last_name: null, profile_picture_url: null, created_at: AT });
    await expect(syncWorkos(held.db, await readWorkos(cfg), { apply: false, now: NOW })).rejects.toThrow('WorkOS lists two users with the email');
  });

  test('the command refuses an unknown flag and missing settings before reading anything', async () => {
    const out: string[] = [];
    const write = (text: string): void => {
      out.push(text);
    };
    expect(await runWorkosSync(['--dry-run'], {}, write)).toBe(2);
    expect(await runWorkosSync([], { DATABASE_URL: 'postgres://x' }, write)).toBe(1);
    expect(await runWorkosSync(['--apply'], { WORKOS_API_KEY: 'sk', WORKOS_CLIENT_ID: 'client' }, write)).toBe(1);
    expect(out).toEqual(['usage: bun apps/api/scripts/workos-sync.ts [--apply]\n', 'WORKOS_API_KEY, WORKOS_CLIENT_ID and DATABASE_URL must be set\n', 'WORKOS_API_KEY, WORKOS_CLIENT_ID and DATABASE_URL must be set\n']);
  });
});
