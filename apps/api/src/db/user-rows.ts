import { eq, sql } from 'drizzle-orm';
import { ApiError } from '@metro-labs/http/api-error';
import { accountId } from './account-ids.js';
import type { Database } from './client.js';
import { users } from './schema.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EMAIL_MAX = 254;

export function cleanEmail(raw: unknown): string {
  const email = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!EMAIL_RE.test(email) || email.length > EMAIL_MAX) throw new ApiError('email does not look like an address', 400);
  return email;
}

const sameEmail = (email: string) => eq(sql`lower(${users.email})`, email.toLowerCase());

async function userWithEmail(db: Database, email: string): Promise<string | null> {
  const rows = await db.select({ id: users.id }).from(users).where(sameEmail(email)).limit(1);
  return rows[0]?.id ?? null;
}

export async function userForEmail(db: Database, email: string, now: number): Promise<{ id: string; created: boolean }> {
  const found = await userWithEmail(db, email);
  if (found !== null) return { id: found, created: false };
  const at = new Date(now).toISOString();
  const id = accountId('user', now);
  const made = await db.insert(users).values({ id, email, createdAt: at, updatedAt: at }).onConflictDoNothing().returning({ id: users.id });
  if (made[0] !== undefined) return { id, created: true };
  const raced = await userWithEmail(db, email);
  if (raced === null) throw new ApiError('could not find or make the user for that email', 503);
  return { id: raced, created: false };
}
