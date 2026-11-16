import { and, eq, isNull } from 'drizzle-orm';
import { ApiError } from '@metro-labs/http/api-error';
import { accountId, newSecret, secretHashOf } from './account-ids.js';
import type { Database } from './client.js';
import { loginLinks, users } from './schema.js';

const CODE_RE = /^[A-Za-z0-9_-]{43}$/;

export interface MadeLoginLink {
  id: string;
  code: string;
}

async function userExists(tx: Database, user: string): Promise<void> {
  const rows = await tx.select({ id: users.id }).from(users).where(eq(users.id, user)).limit(1).for('update');
  if (rows[0] === undefined) throw new ApiError('no such user', 404);
}

export function createLoginLink(db: Database, input: { user: string; by: string; now: number }): Promise<MadeLoginLink> {
  return db.transaction(async (tx) => {
    await userExists(tx, input.user);
    await tx.update(loginLinks).set({ revokedAt: input.now }).where(and(eq(loginLinks.userId, input.user), isNull(loginLinks.revokedAt)));
    const code = newSecret();
    const id = accountId('link', input.now);
    await tx.insert(loginLinks).values({ id, userId: input.user, codeHash: secretHashOf(code), createdBy: input.by, createdAt: input.now });
    return { id, code };
  });
}

export async function redeemLoginLink(db: Database, code: string, now: number): Promise<{ id: string; user: string } | null> {
  if (!CODE_RE.test(code)) return null;
  const rows = await db
    .update(loginLinks)
    .set({ lastUsedAt: now })
    .where(and(eq(loginLinks.codeHash, secretHashOf(code)), isNull(loginLinks.revokedAt)))
    .returning({ id: loginLinks.id, user: loginLinks.userId });
  return rows[0] ?? null;
}

export async function revokeLoginLink(db: Database, id: string, now: number): Promise<boolean> {
  const rows = await db.update(loginLinks).set({ revokedAt: now }).where(and(eq(loginLinks.id, id), isNull(loginLinks.revokedAt))).returning({ id: loginLinks.id });
  return rows.length > 0;
}
