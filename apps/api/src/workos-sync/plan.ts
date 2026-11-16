import type { WorkosUser } from '../auth/workos.js';
import { PROVIDERS } from '../auth/workos.js';
import { accountId } from '../db/account-ids.js';
import type { Database } from '../db/client.js';
import type { IdentityProvider } from '../db/identities.js';
import type { MemberRole } from '../db/memberships.js';
import { identities, memberships, organizations, users } from '../db/schema.js';
import { slugify, withSuffix } from '../slug.js';
import type { Snapshot } from './snapshot.js';

const SLUG_TRIES = 1000;

export interface FieldChange {
  field: 'email' | 'name' | 'picture' | 'created_at';
  from: string | null;
  to: string | null;
}

export interface PlannedMember {
  organization: string;
  user: string;
  email: string | null;
  role: MemberRole;
  invited: boolean;
}

export interface PlannedIdentity {
  provider: IdentityProvider;
  subject: string;
  user: string;
  email: string;
}

export interface Outsider {
  user: string;
  email: string | null;
  signIn: string;
  organizations: number;
}

export interface SyncPlan {
  counts: { organizations: number; users: number; memberships: number; invitations: number; google: number; microsoft: number };
  organizations: { added: { id: string; name: string | null; slug: string }[]; renamed: { id: string; from: string | null; to: string }[]; onlyInMetro: string[] };
  users: { added: WorkosUser[]; changed: { user: WorkosUser; changes: FieldChange[] }[]; emailsMoved: { from: string; to: string; email: string }[]; invited: { id: string; email: string }[] };
  memberships: { added: PlannedMember[]; changed: (PlannedMember & { from: MemberRole })[]; removed: PlannedMember[] };
  identities: { added: PlannedIdentity[]; moved: (PlannedIdentity & { from: string })[] };
  outsiders: Outsider[];
  warnings: string[];
}

interface Current {
  organizations: { id: string; slug: string; name: string | null }[];
  users: { id: string; email: string | null; name: string | null; picture: string | null; createdAt: string | null }[];
  memberships: { organization: string; user: string; role: MemberRole }[];
  identities: { provider: IdentityProvider; subject: string; user: string }[];
}

const keyOf = (a: string, b: string): string => `${a}\n${b}`;

const lower = (email: string): string => email.trim().toLowerCase();

async function readCurrent(db: Database): Promise<Current> {
  return {
    organizations: await db.select({ id: organizations.id, slug: organizations.slug, name: organizations.name }).from(organizations),
    users: await db.select({ id: users.id, email: users.email, name: users.name, picture: users.picture, createdAt: users.createdAt }).from(users),
    memberships: await db.select({ organization: memberships.organization, user: memberships.userId, role: memberships.role }).from(memberships),
    identities: await db.select({ provider: identities.provider, subject: identities.subject, user: identities.userId }).from(identities),
  };
}

function emptyPlan(snapshot: Snapshot): SyncPlan {
  const signIns = (provider: IdentityProvider): number => snapshot.identities.filter((i) => i.provider === provider).length;
  return {
    counts: { organizations: snapshot.organizations.length, users: snapshot.users.length, memberships: snapshot.memberships.length, invitations: snapshot.invitations.length, google: signIns('google'), microsoft: signIns('microsoft') },
    organizations: { added: [], renamed: [], onlyInMetro: [] },
    users: { added: [], changed: [], emailsMoved: [], invited: [] },
    memberships: { added: [], changed: [], removed: [] },
    identities: { added: [], moved: [] },
    outsiders: [],
    warnings: [],
  };
}

function freeSlug(name: string, taken: Set<string>): string {
  const base = slugify(name);
  for (let n = 1; n <= SLUG_TRIES; n += 1) {
    const slug = n === 1 ? base : withSuffix(base, n);
    if (!taken.has(slug)) {
      taken.add(slug);
      return slug;
    }
  }
  throw new Error(`no free slug for ${name}`);
}

function planOrganizations(snapshot: Snapshot, current: Current, plan: SyncPlan): void {
  const held = new Map(current.organizations.map((o) => [o.id, o]));
  const taken = new Set(current.organizations.map((o) => o.slug));
  for (const org of snapshot.organizations) {
    const row = held.get(org.id);
    if (row === undefined) plan.organizations.added.push({ id: org.id, name: org.name, slug: freeSlug(org.name ?? org.id, taken) });
    else if (org.name !== null && org.name !== row.name) plan.organizations.renamed.push({ id: org.id, from: row.name, to: org.name });
  }
  const known = new Set(snapshot.organizations.map((o) => o.id));
  plan.organizations.onlyInMetro = current.organizations.filter((o) => !known.has(o.id)).map((o) => o.id);
}

function changesOf(user: WorkosUser, row: Current['users'][number]): FieldChange[] {
  const out: FieldChange[] = [];
  if (user.email !== row.email) out.push({ field: 'email', from: row.email, to: user.email });
  if (user.name !== row.name) out.push({ field: 'name', from: row.name, to: user.name });
  if (user.picture !== row.picture) out.push({ field: 'picture', from: row.picture, to: user.picture });
  if (row.createdAt === null && user.createdAt !== null) out.push({ field: 'created_at', from: null, to: user.createdAt });
  return out;
}

function refuseDuplicates(snapshot: Snapshot): void {
  const seen = new Map<string, string>();
  for (const user of snapshot.users) {
    if (user.email === null) continue;
    const other = seen.get(lower(user.email));
    if (other !== undefined) throw new Error(`WorkOS lists two users with the email ${user.email} (${other} and ${user.id}); fix that in WorkOS first`);
    seen.set(lower(user.email), user.id);
  }
}

function planUsers(snapshot: Snapshot, current: Current, plan: SyncPlan): void {
  refuseDuplicates(snapshot);
  const rows = new Map(current.users.map((r) => [r.id, r]));
  const workos = new Set(snapshot.users.map((u) => u.id));
  const holders = new Map(current.users.flatMap((r) => (r.email === null ? [] : [[lower(r.email), r.id] as const])));
  for (const user of snapshot.users) {
    const row = rows.get(user.id);
    const changes = row === undefined ? [] : changesOf(user, row);
    if (row === undefined) plan.users.added.push(user);
    else if (changes.length > 0) plan.users.changed.push({ user, changes });
    const holder = user.email === null ? undefined : holders.get(lower(user.email));
    if (user.email !== null && holder !== undefined && holder !== user.id && !workos.has(holder)) plan.users.emailsMoved.push({ from: holder, to: user.id, email: user.email });
  }
}

function emailOwners(snapshot: Snapshot, current: Current, plan: SyncPlan): Map<string, string> {
  const workos = new Set(snapshot.users.map((u) => u.id));
  const moved = new Set(plan.users.emailsMoved.map((m) => m.from));
  const owners = new Map<string, string>();
  for (const row of current.users) if (row.email !== null && !workos.has(row.id) && !moved.has(row.id)) owners.set(lower(row.email), row.id);
  for (const user of snapshot.users) if (user.email !== null) owners.set(lower(user.email), user.id);
  return owners;
}

function roleOf(slug: string | null, where: string, plan: SyncPlan): MemberRole {
  if (slug === 'admin') return 'admin';
  if (slug !== null && slug !== 'member') plan.warnings.push(`${where}: the WorkOS role "${slug}" becomes member`);
  return 'member';
}

function desiredMembers(snapshot: Snapshot, owners: Map<string, string>, emails: Map<string, string | null>, plan: SyncPlan): Map<string, PlannedMember> {
  const desired = new Map<string, PlannedMember>();
  for (const m of snapshot.memberships) {
    if (!emails.has(m.user)) {
      plan.warnings.push(`a membership of ${m.organization} names ${m.user}, a user WorkOS does not list; it is left out`);
      continue;
    }
    desired.set(keyOf(m.organization, m.user), { organization: m.organization, user: m.user, email: emails.get(m.user) ?? null, role: roleOf(m.role, `${emails.get(m.user) ?? m.user} in ${m.organization}`, plan), invited: false });
  }
  for (const invitation of snapshot.invitations) {
    const email = lower(invitation.email);
    const user = owners.get(email) ?? accountId('user');
    if (!owners.has(email)) plan.users.invited.push({ id: user, email });
    owners.set(email, user);
    const key = keyOf(invitation.organization, user);
    if (!desired.has(key)) desired.set(key, { organization: invitation.organization, user, email, role: roleOf(invitation.role, `the invitation of ${email} to ${invitation.organization}`, plan), invited: true });
  }
  return desired;
}

function planMembers(desired: Map<string, PlannedMember>, current: Current, emails: Map<string, string | null>, plan: SyncPlan): void {
  const held = new Map(current.memberships.map((m) => [keyOf(m.organization, m.user), m]));
  for (const [key, want] of desired) {
    const row = held.get(key);
    if (row === undefined) plan.memberships.added.push(want);
    else if (row.role !== want.role) plan.memberships.changed.push({ ...want, from: row.role });
  }
  for (const [key, row] of held) if (!desired.has(key)) plan.memberships.removed.push({ ...row, email: emails.get(row.user) ?? null, invited: false });
}

function warnAdminless(snapshot: Snapshot, desired: Map<string, PlannedMember>, plan: SyncPlan): void {
  const led = new Set([...desired.values()].filter((m) => m.role === 'admin').map((m) => m.organization));
  for (const org of snapshot.organizations) if (!led.has(org.id)) plan.warnings.push(`${org.name ?? org.id} (${org.id}) has no admin`);
}

function planIdentities(snapshot: Snapshot, current: Current, plan: SyncPlan): void {
  const held = new Map(current.identities.map((i) => [keyOf(i.provider, i.subject), i]));
  const emails = new Map(snapshot.users.map((u) => [u.id, u.email]));
  const seen = new Set<string>();
  for (const identity of snapshot.identities) {
    const email = emails.get(identity.user) ?? null;
    const key = keyOf(identity.provider, identity.subject);
    if (email === null || seen.has(key)) {
      plan.warnings.push(`the ${identity.provider} sign-in ${identity.subject} of ${identity.user} is left out: ${email === null ? 'the user has no email' : 'WorkOS lists it twice'}`);
      continue;
    }
    seen.add(key);
    const want = { provider: identity.provider, subject: identity.subject, user: identity.user, email: lower(email) };
    const row = held.get(key);
    if (row === undefined) plan.identities.added.push(want);
    else if (row.user !== identity.user) plan.identities.moved.push({ ...want, from: row.user });
  }
}

function planOutsiders(snapshot: Snapshot, desired: Map<string, PlannedMember>, plan: SyncPlan): void {
  const covered = new Set([...snapshot.identities, ...snapshot.unmapped].map((i) => i.user));
  const others = new Map(snapshot.otherSignIns.map((i) => [i.user, i.provider === PROVIDERS.github ? 'github' : i.provider]));
  const memberOf = new Map<string, number>();
  for (const m of desired.values()) memberOf.set(m.user, (memberOf.get(m.user) ?? 0) + 1);
  for (const user of snapshot.users) {
    if (covered.has(user.id)) continue;
    plan.outsiders.push({ user: user.id, email: user.email, signIn: others.get(user.id) ?? 'email', organizations: memberOf.get(user.id) ?? 0 });
  }
  const emails = new Map(snapshot.users.map((u) => [u.id, u.email]));
  for (const i of snapshot.unmapped) plan.warnings.push(`the ${i.provider} sign-in of ${emails.get(i.user) ?? i.user} has an id Metro cannot map (${i.idpId}); it is left out`);
}

export async function planSync(db: Database, snapshot: Snapshot): Promise<SyncPlan> {
  const current = await readCurrent(db);
  const plan = emptyPlan(snapshot);
  planOrganizations(snapshot, current, plan);
  planUsers(snapshot, current, plan);
  const emails = new Map<string, string | null>([...current.users.map((r) => [r.id, r.email] as const), ...snapshot.users.map((u) => [u.id, u.email] as const)]);
  const desired = desiredMembers(snapshot, emailOwners(snapshot, current, plan), new Map(snapshot.users.map((u) => [u.id, u.email])), plan);
  planMembers(desired, current, emails, plan);
  warnAdminless(snapshot, desired, plan);
  planIdentities(snapshot, current, plan);
  planOutsiders(snapshot, desired, plan);
  return plan;
}
