import { eq, type SQL } from 'drizzle-orm';
import { ApiError } from '../daemon/api-error.js';
import { getDb } from './client.js';
import { newId } from './ids.js';
import { users } from './schema.js';

const UNIQUE_VIOLATION = '23505';
const ADDRESS_RE = /^0x[0-9a-f]{40}$/;

export class UserError extends ApiError {}

const CAUSE_DEPTH = 5;

export function isUniqueViolation(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < CAUSE_DEPTH; depth += 1) {
    if (typeof current !== 'object' || current === null) return false;
    const { code, cause } = current as { code?: unknown; cause?: unknown };
    if (code === UNIQUE_VIOLATION) return true;
    current = cause;
  }
  return false;
}

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

export function normalizeAddress(raw: string): string | null {
  const address = raw.trim().toLowerCase();
  return ADDRESS_RE.test(address) ? address : null;
}

async function userIdWhere(where: SQL): Promise<string | null> {
  const rows = await getDb().select({ id: users.id }).from(users).where(where);
  return rows[0]?.id ?? null;
}

export async function userIdForSubject(subject: string): Promise<string | null> {
  const address = normalizeAddress(subject);
  if (address !== null) return userIdWhere(eq(users.address, address));
  return userIdWhere(eq(users.email, normalizeEmail(subject)));
}

export async function resolveUserId(
  insert: () => Promise<string | undefined>,
  lookup: () => Promise<string | null>,
): Promise<string> {
  const inserted = await insert();
  if (inserted !== undefined) return inserted;
  const existing = await lookup();
  if (existing === null)
    throw new UserError('user lookup returned no id', 500);
  return existing;
}

export async function ensureUserByAddress(raw: string): Promise<string> {
  const address = normalizeAddress(raw);
  if (address === null)
    throw new UserError('an Ethereum address is required', 400);
  return resolveUserId(
    async () => {
      const rows = await getDb()
        .insert(users)
        .values({ id: newId(), address })
        .onConflictDoNothing({ target: users.address })
        .returning({ id: users.id });
      return rows[0]?.id;
    },
    () => userIdWhere(eq(users.address, address)),
  );
}
