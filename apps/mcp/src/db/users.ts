import { eq } from 'drizzle-orm';
import { ApiError } from '../daemon/api-error.js';
import { getDb } from './client.js';
import { newId } from './ids.js';
import { users } from './schema.js';

const UNIQUE_VIOLATION = '23505';

export class UserError extends ApiError {}

export function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === UNIQUE_VIOLATION
  );
}

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

export async function userIdForEmail(rawEmail: string): Promise<string | null> {
  const email = normalizeEmail(rawEmail);
  const rows = await getDb()
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email));
  return rows[0]?.id ?? null;
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

export async function ensureUser(rawEmail: string): Promise<string> {
  const email = normalizeEmail(rawEmail);
  return resolveUserId(
    async () => {
      const rows = await getDb()
        .insert(users)
        .values({ id: newId(), email })
        .onConflictDoNothing({ target: users.email })
        .returning({ id: users.id });
      return rows[0]?.id;
    },
    () => userIdForEmail(email),
  );
}
