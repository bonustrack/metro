import type { UserStore, UserStatus } from '../users.js';
import type { Tokens } from './workos.js';

const OPERATOR_EMAIL = 'admin@stage.box';

export const isOperatorEmail = (email: string | null): boolean => email?.toLowerCase() === OPERATOR_EMAIL;

export type Intent = 'login' | 'waitlist';

export type Refusal = 'no-account' | 'waiting' | 'not-open' | 'unverified' | 'cancelled' | 'failed';

export type Admission = { kind: 'in' } | { kind: 'waiting' } | { kind: 'refused'; reason: Refusal };

const letIn = (status: UserStatus | null, t: Tokens): boolean => status === 'approved' || isOperatorEmail(t.user.email) || t.organization !== null;

export async function admit(users: UserStore, t: Tokens, intent: Intent, at: string): Promise<Admission> {
  const status = (await users.find(t.user.id))?.status ?? null;
  await users.noteLogin(t.user, at);
  if (status === 'rejected') return { kind: 'refused', reason: 'not-open' };
  if (letIn(status, t)) {
    if (status !== 'approved' && isOperatorEmail(t.user.email)) await users.setStatus(t.user.id, 'approved');
    return { kind: 'in' };
  }
  if (intent === 'waitlist') {
    if (status === null) await users.setStatus(t.user.id, 'waitlist');
    return { kind: 'waiting' };
  }
  return { kind: 'refused', reason: status === 'waitlist' ? 'waiting' : 'no-account' };
}

export async function mayCreateOrganization(users: UserStore, user: string): Promise<boolean> {
  const record = await users.find(user);
  return record?.status === 'approved' || isOperatorEmail(record?.email ?? null);
}

export async function stillIn(users: UserStore, t: Tokens): Promise<boolean> {
  const status = (await users.find(t.user.id))?.status ?? null;
  return status !== 'rejected' && letIn(status, t);
}
