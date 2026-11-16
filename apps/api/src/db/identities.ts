import { and, eq } from 'drizzle-orm';
import { ApiError } from '@metro-labs/http/api-error';
import type { Database } from './client.js';
import { identities } from './schema.js';
import { cleanEmail, userForEmail } from './user-rows.js';

export type IdentityProvider = 'google' | 'microsoft';

const PROVIDER_NAMES: Record<IdentityProvider, string> = { google: 'Google', microsoft: 'Microsoft' };
const GUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const SUBJECT_RE: Record<IdentityProvider, RegExp> = { google: /^[\x21-\x7e]{1,255}$/, microsoft: new RegExp(`^${GUID}:${GUID}$`) };

export const isIdentitySubject = (provider: IdentityProvider, subject: string): boolean => SUBJECT_RE[provider].test(subject);

export interface SignIn {
  provider: IdentityProvider;
  subject: string;
  email: string | null;
  emailProven: boolean;
  now: number;
}

export interface LinkedUser {
  user: string;
  kind: 'known' | 'linked' | 'created';
}

const ofIdentity = (provider: IdentityProvider, subject: string) => and(eq(identities.provider, provider), eq(identities.subject, subject));

async function known(tx: Database, provider: IdentityProvider, subject: string, now: number): Promise<string | null> {
  const rows = await tx.update(identities).set({ lastUsedAt: now }).where(ofIdentity(provider, subject)).returning({ user: identities.userId });
  return rows[0]?.user ?? null;
}

export async function hasIdentity(tx: Database, user: string): Promise<boolean> {
  return (await tx.$count(identities, eq(identities.userId, user))) > 0;
}

function provenEmail(input: SignIn): string {
  if (input.email === null || !input.emailProven) throw new ApiError(`${PROVIDER_NAMES[input.provider]} did not confirm this email address, so Metro cannot tell whose account it is`, 403);
  return cleanEmail(input.email);
}

async function link(tx: Database, input: SignIn): Promise<LinkedUser> {
  const email = provenEmail(input);
  const user = await userForEmail(tx, email, input.now);
  if (!user.created && (await hasIdentity(tx, user.id))) throw new ApiError(`${email} already signs in with another account`, 409);
  const made = await tx
    .insert(identities)
    .values({ provider: input.provider, subject: input.subject, userId: user.id, email, createdAt: input.now, lastUsedAt: input.now })
    .onConflictDoNothing()
    .returning({ user: identities.userId });
  if (made[0] !== undefined) return { user: user.id, kind: user.created ? 'created' : 'linked' };
  const raced = await known(tx, input.provider, input.subject, input.now);
  if (raced === null) throw new ApiError('could not link that sign-in, try again', 503);
  return { user: raced, kind: 'known' };
}

export async function linkIdentity(db: Database, input: SignIn): Promise<LinkedUser> {
  if (!isIdentitySubject(input.provider, input.subject)) throw new ApiError('that sign-in has no usable account id', 400);
  return db.transaction(async (tx) => {
    const user = await known(tx, input.provider, input.subject, input.now);
    return user === null ? link(tx, input) : { user, kind: 'known' };
  });
}
