import { and, eq, gt, isNotNull, isNull, lte, or } from 'drizzle-orm';
import { accountId, newSecret, secretHashOf } from './account-ids.js';
import type { Database } from './client.js';
import { authSessions, authSpentTokens } from './schema.js';

const DAY_MS = 24 * 60 * 60_000;

export const SESSION_IDLE_MS = 30 * DAY_MS;
export const SESSION_MAX_MS = 90 * DAY_MS;
export const ROTATION_GRACE_MS = 60_000;

const REFRESH_PREFIX = 'mrt_';
const TOKEN_RE = /^mrt_[A-Za-z0-9_-]{43}$/;

type SessionRow = typeof authSessions.$inferSelect;

export type NewSessionMethod = 'google' | 'microsoft';

export interface AuthSession {
  id: string;
  user: string;
  method: SessionRow['method'];
  createdAt: number;
  expiresAt: number;
}

export interface IssuedSession {
  session: AuthSession;
  refreshToken: string;
}

export type Rotation = ({ kind: 'rotated' } & IssuedSession) | { kind: 'refused'; reason: 'unknown' | 'revoked' | 'expired' | 'reused' };

const deadline = (createdAt: number, now: number): number => Math.min(now + SESSION_IDLE_MS, createdAt + SESSION_MAX_MS);

const sessionOf = (row: Pick<SessionRow, 'id' | 'userId' | 'method' | 'createdAt' | 'expiresAt'>): AuthSession => ({ id: row.id, user: row.userId, method: row.method, createdAt: row.createdAt, expiresAt: row.expiresAt });

const newRefreshToken = (): string => `${REFRESH_PREFIX}${newSecret()}`;

export async function createSession(db: Database, input: { user: string; method: NewSessionMethod; now: number }): Promise<IssuedSession> {
  const refreshToken = newRefreshToken();
  const row = { id: accountId('session', input.now), userId: input.user, method: input.method, refreshHash: secretHashOf(refreshToken), createdAt: input.now, lastUsedAt: input.now, expiresAt: deadline(input.now, input.now) };
  await db.insert(authSessions).values(row);
  return { session: sessionOf(row), refreshToken };
}

const refused = (reason: Extract<Rotation, { kind: 'refused' }>['reason']): Rotation => ({ kind: 'refused', reason });

async function rotate(tx: Database, row: SessionRow, now: number): Promise<Rotation> {
  const refreshToken = newRefreshToken();
  const expiresAt = deadline(row.createdAt, now);
  await tx.insert(authSpentTokens).values({ hash: row.refreshHash, session: row.id, spentAt: now }).onConflictDoNothing();
  await tx.update(authSessions).set({ refreshHash: secretHashOf(refreshToken), previousHash: row.refreshHash, rotatedAt: now, lastUsedAt: now, expiresAt }).where(eq(authSessions.id, row.id));
  return { kind: 'rotated', session: sessionOf({ ...row, expiresAt }), refreshToken };
}

async function reused(tx: Database, session: string, now: number): Promise<Rotation> {
  await tx.update(authSessions).set({ revokedAt: now }).where(and(eq(authSessions.id, session), isNull(authSessions.revokedAt)));
  return refused('reused');
}

async function spentBy(tx: Database, hash: string, now: number): Promise<Rotation> {
  const rows = await tx.select({ session: authSpentTokens.session }).from(authSpentTokens).where(eq(authSpentTokens.hash, hash)).limit(1);
  const session = rows[0]?.session;
  return session === undefined ? refused('unknown') : reused(tx, session, now);
}

async function rotateIn(tx: Database, hash: string, now: number): Promise<Rotation> {
  const rows = await tx.select().from(authSessions).where(or(eq(authSessions.refreshHash, hash), eq(authSessions.previousHash, hash))).limit(1).for('update');
  const row = rows[0];
  if (row === undefined) return spentBy(tx, hash, now);
  if (row.revokedAt !== null) return refused('revoked');
  if (row.expiresAt <= now) return refused('expired');
  if (row.refreshHash === hash || (row.rotatedAt !== null && now - row.rotatedAt <= ROTATION_GRACE_MS)) return rotate(tx, row, now);
  return reused(tx, row.id, now);
}

export async function rotateSession(db: Database, refreshToken: string, now: number): Promise<Rotation> {
  if (!TOKEN_RE.test(refreshToken)) return refused('unknown');
  return db.transaction((tx) => rotateIn(tx, secretHashOf(refreshToken), now));
}

export async function liveSession(db: Database, id: string, now: number): Promise<AuthSession | null> {
  const rows = await db.select().from(authSessions).where(and(eq(authSessions.id, id), isNull(authSessions.revokedAt), gt(authSessions.expiresAt, now))).limit(1);
  const row = rows[0];
  return row === undefined ? null : sessionOf(row);
}

export async function revokeSession(db: Database, id: string, now: number): Promise<boolean> {
  const rows = await db.update(authSessions).set({ revokedAt: now }).where(and(eq(authSessions.id, id), isNull(authSessions.revokedAt))).returning({ id: authSessions.id });
  return rows.length > 0;
}

export async function pruneSessions(db: Database, now: number): Promise<number> {
  const rows = await db.delete(authSessions).where(or(lte(authSessions.expiresAt, now), isNotNull(authSessions.revokedAt))).returning({ id: authSessions.id });
  return rows.length;
}
