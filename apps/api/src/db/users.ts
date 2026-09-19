import { desc, eq, inArray, sql } from 'drizzle-orm';
import { getDb } from './client.js';
import { users } from './schema.js';
import type { UserLogin, UserRecord, UserStore } from '../users.js';

const RECORD = {
  id: users.id,
  email: users.email,
  name: users.name,
  picture: users.picture,
  avatar: users.avatar,
  createdAt: users.createdAt,
  lastLoginAt: users.lastLoginAt,
};

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

async function noteLogin(user: UserLogin, at: string): Promise<void> {
  const seen = { email: user.email, name: user.name, picture: user.picture, lastLoginAt: at, updatedAt: at };
  await getDb()
    .insert(users)
    .values({ id: user.id, createdAt: user.createdAt ?? at, ...seen })
    .onConflictDoUpdate({ target: users.id, set: { ...seen, createdAt: sql`coalesce(${users.createdAt}, excluded.created_at)` } });
}

async function find(user: string): Promise<UserRecord | null> {
  const rows = await getDb().select(RECORD).from(users).where(eq(users.id, user)).limit(1);
  return rows[0] ?? null;
}

async function list(): Promise<UserRecord[]> {
  return getDb().select(RECORD).from(users).orderBy(desc(users.lastLoginAt), users.id);
}

export const dbUsers: UserStore = { avatar, avatars, setAvatar, noteLogin, find, list };
