import { and, asc, eq, sql } from 'drizzle-orm';
import { ApiError } from '@metro-labs/http/api-error';
import { accountId } from './account-ids.js';
import type { Database } from './client.js';
import { memberships, organizations, users } from './schema.js';
import { cleanEmail, userForEmail } from './user-rows.js';

export type MemberRole = 'admin' | 'member';

export const isMemberRole = (value: unknown): value is MemberRole => value === 'admin' || value === 'member';

export interface NewMember {
  organization: string;
  email: string;
  role: MemberRole;
  by: string;
  now: number;
}

export interface MemberChange {
  organization: string;
  user: string;
  by: string;
}

export interface OrganizationMember {
  id: string;
  user: string;
  email: string | null;
  name: string | null;
  picture: string | null;
  role: MemberRole;
  addedBy: string | null;
  lastLoginAt: string | null;
  createdAt: number;
}

export interface MemberOrganization {
  id: string;
  slug: string;
  name: string | null;
  role: MemberRole;
}

const ofMember = (organization: string, user: string) => and(eq(memberships.organization, organization), eq(memberships.userId, user));

async function lockOrganization(tx: Database, organization: string): Promise<void> {
  const rows = await tx.select({ id: organizations.id }).from(organizations).where(eq(organizations.id, organization)).for('update');
  if (rows[0] === undefined) throw new ApiError('no such organization', 404);
}

async function roleIn(tx: Database, organization: string, user: string): Promise<MemberRole | null> {
  const rows = await tx.select({ role: memberships.role }).from(memberships).where(ofMember(organization, user)).limit(1);
  return rows[0]?.role ?? null;
}

async function requireAdmin(tx: Database, organization: string, by: string): Promise<void> {
  await lockOrganization(tx, organization);
  if ((await roleIn(tx, organization, by)) !== 'admin') throw new ApiError('this needs the admin role in your organization', 403);
}

async function keepsAnAdmin(tx: Database, organization: string): Promise<void> {
  const admins = await tx.$count(memberships, and(eq(memberships.organization, organization), eq(memberships.role, 'admin')));
  if (admins <= 1) throw new ApiError('the organization needs at least one admin', 400);
}

async function memberRole(tx: Database, organization: string, user: string): Promise<MemberRole> {
  const role = await roleIn(tx, organization, user);
  if (role === null) throw new ApiError('no such member', 404);
  return role;
}

export async function addMember(db: Database, input: NewMember): Promise<{ id: string; user: string; email: string; createdUser: boolean }> {
  const email = cleanEmail(input.email);
  return db.transaction(async (tx) => {
    await requireAdmin(tx, input.organization, input.by);
    const user = await userForEmail(tx, email, input.now);
    const id = accountId('om', input.now);
    const added = await tx
      .insert(memberships)
      .values({ id, organization: input.organization, userId: user.id, role: input.role, addedBy: input.by, createdAt: input.now, updatedAt: input.now })
      .onConflictDoNothing()
      .returning({ id: memberships.id });
    if (added[0] === undefined) throw new ApiError('that person is already a member', 409);
    return { id, user: user.id, email, createdUser: user.created };
  });
}

export function setMemberRole(db: Database, change: MemberChange & { role: MemberRole; now: number }): Promise<void> {
  return db.transaction(async (tx) => {
    await requireAdmin(tx, change.organization, change.by);
    const current = await memberRole(tx, change.organization, change.user);
    if (current === change.role) return;
    if (change.user === change.by) throw new ApiError('you cannot take your own admin role away', 400);
    if (current === 'admin') await keepsAnAdmin(tx, change.organization);
    await tx.update(memberships).set({ role: change.role, updatedAt: change.now }).where(ofMember(change.organization, change.user));
  });
}

export async function removeMember(db: Database, change: MemberChange): Promise<void> {
  if (change.user === change.by) throw new ApiError('you cannot remove yourself', 400);
  return db.transaction(async (tx) => {
    await requireAdmin(tx, change.organization, change.by);
    if ((await memberRole(tx, change.organization, change.user)) === 'admin') await keepsAnAdmin(tx, change.organization);
    await tx.delete(memberships).where(ofMember(change.organization, change.user));
  });
}

export function membersOf(db: Database, organization: string): Promise<OrganizationMember[]> {
  return db
    .select({
      id: memberships.id,
      user: memberships.userId,
      email: users.email,
      name: users.name,
      picture: sql<string | null>`coalesce(${users.avatar}, ${users.picture})`,
      role: memberships.role,
      addedBy: memberships.addedBy,
      lastLoginAt: users.lastLoginAt,
      createdAt: memberships.createdAt,
    })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(eq(memberships.organization, organization))
    .orderBy(asc(memberships.createdAt), asc(memberships.id));
}

export function organizationsOf(db: Database, user: string): Promise<MemberOrganization[]> {
  return db
    .select({ id: organizations.id, slug: organizations.slug, name: organizations.name, role: memberships.role })
    .from(memberships)
    .innerJoin(organizations, eq(organizations.id, memberships.organization))
    .where(eq(memberships.userId, user))
    .orderBy(sql`lower(coalesce(${organizations.name}, ${organizations.slug}))`, asc(organizations.id));
}

export async function oldestMembership(db: Database, user: string): Promise<{ id: string; role: MemberRole } | null> {
  const rows = await db.select({ id: memberships.organization, role: memberships.role }).from(memberships).where(eq(memberships.userId, user)).orderBy(asc(memberships.createdAt), asc(memberships.id)).limit(1);
  return rows[0] ?? null;
}
