import { desc, eq, inArray, sql } from 'drizzle-orm';
import { log } from '@metro-labs/core/log';
import { isUniqueViolation } from '@metro-labs/connectors/db/errors';
import { getDb, type Database } from './client.js';
import { users } from './schema.js';
import { isUserStatus, type UserLogin, type UserRecord, type UserStatus, type UserStore } from '../users.js';

const RECORD = {
  id: users.id,
  email: users.email,
  name: users.name,
  picture: users.picture,
  avatar: users.avatar,
  createdAt: users.createdAt,
  lastLoginAt: users.lastLoginAt,
  status: users.status,
};

const record = (row: Omit<UserRecord, 'status'> & { status: string | null }): UserRecord => ({ ...row, status: isUserStatus(row.status) ? row.status : null });

async function writeLogin(db: Database, user: UserLogin, at: string, withEmail: boolean): Promise<void> {
  const seen = { name: user.name, picture: user.picture, lastLoginAt: at, updatedAt: at, ...(withEmail ? { email: user.email } : {}) };
  await db
    .insert(users)
    .values({ id: user.id, createdAt: user.createdAt ?? at, ...seen })
    .onConflictDoUpdate({ target: users.id, set: { ...seen, createdAt: sql`coalesce(${users.createdAt}, excluded.created_at)` } });
}

export async function noteLoginIn(db: Database, user: UserLogin, at: string): Promise<void> {
  try {
    await writeLogin(db, user, at, true);
  } catch (err) {
    if (user.email === null || !isUniqueViolation(err)) throw err;
    log.warn({ user: user.id }, 'users: another user row holds this email, the login is noted without it');
    await writeLogin(db, user, at, false);
  }
}

export function userStore(db: () => Database): UserStore {
  async function avatar(user: string): Promise<string | null> {
    const rows = await db().select({ avatar: users.avatar }).from(users).where(eq(users.id, user)).limit(1);
    return rows[0]?.avatar ?? null;
  }

  async function avatars(ids: string[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const rows = await db().select({ id: users.id, avatar: users.avatar }).from(users).where(inArray(users.id, ids));
    return new Map(rows.flatMap((r) => (r.avatar === null ? [] : [[r.id, r.avatar] as const])));
  }

  async function setAvatar(user: string, next: string | null): Promise<void> {
    const updatedAt = new Date().toISOString();
    await db()
      .insert(users)
      .values({ id: user, avatar: next, updatedAt })
      .onConflictDoUpdate({ target: users.id, set: { avatar: next, updatedAt } });
  }

  async function find(user: string): Promise<UserRecord | null> {
    const rows = await db().select(RECORD).from(users).where(eq(users.id, user)).limit(1);
    const row = rows[0];
    return row === undefined ? null : record(row);
  }

  async function list(): Promise<UserRecord[]> {
    return (await db().select(RECORD).from(users).orderBy(desc(users.lastLoginAt), users.id)).map(record);
  }

  async function setStatus(user: string, status: UserStatus): Promise<void> {
    const updatedAt = new Date().toISOString();
    await db()
      .insert(users)
      .values({ id: user, status, updatedAt })
      .onConflictDoUpdate({ target: users.id, set: { status, updatedAt } });
  }

  return { avatar, avatars, setAvatar, noteLogin: (user, at) => noteLoginIn(db(), user, at), find, list, setStatus };
}

export const dbUsers: UserStore = userStore(getDb);
