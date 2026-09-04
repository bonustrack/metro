import { eq } from 'drizzle-orm';
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

export function normalizeAddress(raw: string): string | null {
  const address = raw.trim().toLowerCase();
  return ADDRESS_RE.test(address) ? address : null;
}

export async function ensureUserByAddress(raw: string): Promise<string> {
  const address = normalizeAddress(raw);
  if (address === null) throw new UserError('an Ethereum address is required', 400);
  const db = getDb();
  const inserted = await db
    .insert(users)
    .values({ id: newId(), address })
    .onConflictDoNothing({ target: users.address })
    .returning({ id: users.id });
  const id = inserted[0]?.id;
  if (id !== undefined) return id;
  const rows = await db.select({ id: users.id }).from(users).where(eq(users.address, address));
  const existing = rows[0]?.id;
  if (existing === undefined) throw new UserError('user lookup returned no id', 500);
  return existing;
}
