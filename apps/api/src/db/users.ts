import { eq, inArray } from 'drizzle-orm';
import { getDb } from './client.js';
import { users } from './schema.js';
import type { UserStore } from '../users.js';

async function avatar(user: string): Promise<string | null> {
  const rows = await getDb().select({ avatar: users.avatar }).from(users).where(eq(users.id, user)).limit(1);
  return rows[0]?.avatar ?? null;
}

async function avatars(ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await getDb().select({ id: users.id, avatar: users.avatar }).from(users).where(inArray(users.id, ids));
  return new Map(rows.flatMap((r) => (r.avatar === null ? [] : [[r.id, r.avatar] as const])));
}

async function setAvatar(user: string, next: string | null): Promise<void> {
  const updatedAt = new Date().toISOString();
  await getDb()
    .insert(users)
    .values({ id: user, avatar: next, updatedAt })
    .onConflictDoUpdate({ target: users.id, set: { avatar: next, updatedAt } });
}

export const dbUsers: UserStore = { avatar, avatars, setAvatar };
