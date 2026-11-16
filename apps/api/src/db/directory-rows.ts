import { asc, eq } from 'drizzle-orm';
import { ApiError } from '@metro-labs/http/api-error';
import { slugify, withSuffix } from '../slug.js';
import { accountId } from './account-ids.js';
import type { Database } from './client.js';
import { memberships, organizations, users } from './schema.js';

const SLUG_TRIES = 50;

export interface OrganizationRow {
  id: string;
  name: string | null;
  createdAt: string | null;
}

export function createOrganizationRow(db: Database, input: { name: string; creator: string; now: number }): Promise<{ id: string; slug: string }> {
  const id = accountId('org', input.now);
  const at = new Date(input.now).toISOString();
  const base = slugify(input.name);
  return db.transaction(async (tx) => {
    for (let n = 1; n <= SLUG_TRIES; n += 1) {
      const slug = n === 1 ? base : withSuffix(base, n);
      const made = await tx.insert(organizations).values({ id, slug, name: input.name, createdAt: at, updatedAt: at }).onConflictDoNothing().returning({ id: organizations.id });
      if (made[0] === undefined) continue;
      await tx.insert(memberships).values({ id: accountId('om', input.now), organization: id, userId: input.creator, role: 'admin', createdAt: input.now, updatedAt: input.now });
      return { id, slug };
    }
    throw new ApiError('could not find a free slug for that organization', 409);
  });
}

export async function renameOrganizationRow(db: Database, id: string, name: string, now: number): Promise<string> {
  const rows = await db.update(organizations).set({ name, updatedAt: new Date(now).toISOString() }).where(eq(organizations.id, id)).returning({ name: organizations.name });
  const row = rows[0];
  if (row === undefined) throw new ApiError('no such organization', 404);
  return row.name ?? name;
}

export async function organizationNameOf(db: Database, id: string): Promise<string | null> {
  const rows = await db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, id)).limit(1);
  return rows[0]?.name ?? null;
}

export function allOrganizations(db: Database): Promise<OrganizationRow[]> {
  return db.select({ id: organizations.id, name: organizations.name, createdAt: organizations.createdAt }).from(organizations).orderBy(asc(organizations.createdAt), asc(organizations.id));
}

export async function setUserName(db: Database, user: string, name: string, now: number): Promise<void> {
  const rows = await db.update(users).set({ name, updatedAt: new Date(now).toISOString() }).where(eq(users.id, user)).returning({ id: users.id });
  if (rows[0] === undefined) throw new ApiError('no such user', 404);
}
