import { and, asc, eq, gt, isNull } from 'drizzle-orm';
import { ApiError } from '@metro-labs/http/api-error';
import { accountId, newSecret, secretHashOf } from './account-ids.js';
import type { Database } from './client.js';
import { loginLinks, users } from './schema.js';

const CODE_RE = /^[A-Za-z0-9_-]{43}$/;

export const LOGIN_LINK_TTL_MS = 7 * 24 * 60 * 60_000;

export interface MadeLoginLink {
  id: string;
  code: string;
  expiresAt: number;
}

export interface RedeemedLink {
  id: string;
  user: string;
  createdBy: string;
}

async function userExists(tx: Database, user: string): Promise<void> {
  const rows = await tx.select({ id: users.id }).from(users).where(eq(users.id, user)).limit(1).for('update');
  if (rows[0] === undefined) throw new ApiError('no such user', 404);
}

const open = (now: number) => and(isNull(loginLinks.revokedAt), isNull(loginLinks.usedAt), gt(loginLinks.expiresAt, now));

export function createLoginLink(db: Database, input: { user: string; by: string; now: number }): Promise<MadeLoginLink> {
  return db.transaction(async (tx) => {
    await userExists(tx, input.user);
    await tx.update(loginLinks).set({ revokedAt: input.now }).where(and(eq(loginLinks.userId, input.user), isNull(loginLinks.revokedAt), isNull(loginLinks.usedAt)));
    const code = newSecret();
    const id = accountId('link', input.now);
    const expiresAt = input.now + LOGIN_LINK_TTL_MS;
    await tx.insert(loginLinks).values({ id, userId: input.user, codeHash: secretHashOf(code), createdBy: input.by, createdAt: input.now, expiresAt });
    return { id, code, expiresAt };
  });
}

export async function redeemLoginLink(db: Database, code: string, now: number): Promise<RedeemedLink | null> {
  if (!CODE_RE.test(code)) return null;
  const rows = await db
    .update(loginLinks)
    .set({ lastUsedAt: now, usedAt: now })
    .where(and(eq(loginLinks.codeHash, secretHashOf(code)), open(now)))
    .returning({ id: loginLinks.id, user: loginLinks.userId, createdBy: loginLinks.createdBy });
  return rows[0] ?? null;
}

export async function revokeUserLoginLinks(db: Database, user: string, now: number): Promise<string[]> {
  const rows = await db.update(loginLinks).set({ revokedAt: now }).where(and(eq(loginLinks.userId, user), isNull(loginLinks.revokedAt))).returning({ id: loginLinks.id });
  return rows.map((r) => r.id);
}

export interface LoginLinkState {
  id: string;
  createdAt: number;
  expiresAt: number | null;
  usedAt: number | null;
}

export async function currentLoginLinks(db: Database): Promise<Map<string, LoginLinkState>> {
  const rows = await db
    .select({ id: loginLinks.id, user: loginLinks.userId, createdAt: loginLinks.createdAt, expiresAt: loginLinks.expiresAt, usedAt: loginLinks.usedAt })
    .from(loginLinks)
    .where(isNull(loginLinks.revokedAt))
    .orderBy(asc(loginLinks.createdAt), asc(loginLinks.id));
  return new Map(rows.map((r) => [r.user, { id: r.id, createdAt: r.createdAt, expiresAt: r.expiresAt, usedAt: r.usedAt }]));
}
