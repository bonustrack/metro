import { and, eq, inArray, sql } from 'drizzle-orm';
import { accountId } from '../db/account-ids.js';
import type { Database } from '../db/client.js';
import { identities, memberships, organizations, users } from '../db/schema.js';
import type { SyncPlan } from './plan.js';

const CHUNK = 500;

function chunks<T>(rows: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += CHUNK) out.push(rows.slice(i, i + CHUNK));
  return out;
}

async function freeEmails(tx: Database, plan: SyncPlan, at: string): Promise<void> {
  const changing = plan.users.changed.filter((c) => c.changes.some((f) => f.field === 'email')).map((c) => c.user.id);
  const ids = [...plan.users.emailsMoved.map((m) => m.from), ...changing];
  for (const batch of chunks(ids)) await tx.update(users).set({ email: null, updatedAt: at }).where(inArray(users.id, batch));
}

async function writeUsers(tx: Database, plan: SyncPlan, at: string): Promise<void> {
  const rows = [...plan.users.added, ...plan.users.changed.map((c) => c.user)].map((u) => ({ id: u.id, email: u.email, name: u.name, picture: u.picture, createdAt: u.createdAt ?? at, updatedAt: at }));
  const set = { email: sql`excluded.email`, name: sql`excluded.name`, picture: sql`excluded.picture`, updatedAt: sql`excluded.updated_at`, createdAt: sql`coalesce(${users.createdAt}, excluded.created_at)` };
  for (const batch of chunks(rows)) await tx.insert(users).values(batch).onConflictDoUpdate({ target: users.id, set });
  const invited = plan.users.invited.map((i) => ({ id: i.id, email: i.email, createdAt: at, updatedAt: at }));
  for (const batch of chunks(invited)) await tx.insert(users).values(batch);
}

async function writeOrganizations(tx: Database, plan: SyncPlan, at: string): Promise<void> {
  const rows = plan.organizations.added.map((o) => ({ id: o.id, slug: o.slug, name: o.name, createdAt: at, updatedAt: at }));
  for (const batch of chunks(rows)) await tx.insert(organizations).values(batch);
  for (const r of plan.organizations.renamed) await tx.update(organizations).set({ name: r.to, updatedAt: at }).where(eq(organizations.id, r.id));
}

const ofMember = (organization: string, user: string) => and(eq(memberships.organization, organization), eq(memberships.userId, user));

async function writeMemberships(tx: Database, plan: SyncPlan, now: number): Promise<void> {
  for (const m of plan.memberships.removed) await tx.delete(memberships).where(ofMember(m.organization, m.user));
  for (const m of plan.memberships.changed) await tx.update(memberships).set({ role: m.role, updatedAt: now }).where(ofMember(m.organization, m.user));
  const rows = plan.memberships.added.map((m) => ({ id: accountId('om', now), organization: m.organization, userId: m.user, role: m.role, createdAt: now, updatedAt: now }));
  for (const batch of chunks(rows)) await tx.insert(memberships).values(batch);
}

async function writeIdentities(tx: Database, plan: SyncPlan, now: number): Promise<void> {
  for (const i of plan.identities.moved) await tx.update(identities).set({ userId: i.user, email: i.email }).where(and(eq(identities.provider, i.provider), eq(identities.subject, i.subject)));
  const rows = plan.identities.added.map((i) => ({ provider: i.provider, subject: i.subject, userId: i.user, email: i.email, createdAt: now }));
  for (const batch of chunks(rows)) await tx.insert(identities).values(batch);
}

export async function applyPlan(tx: Database, plan: SyncPlan, now: number): Promise<void> {
  const at = new Date(now).toISOString();
  await freeEmails(tx, plan, at);
  await writeUsers(tx, plan, at);
  await writeOrganizations(tx, plan, at);
  await writeMemberships(tx, plan, now);
  await writeIdentities(tx, plan, now);
}
