import type { UserStore, UserStatus } from '../users.js';
import type { Tokens } from './workos.js';

export const OPERATOR_EMAIL = 'admin@stage.box';

export const isOperatorEmail = (email: string | null): boolean => email?.toLowerCase() === OPERATOR_EMAIL;

export type Intent = 'login' | 'waitlist';

export type Admission = { kind: 'in' } | { kind: 'waiting' } | { kind: 'refused'; reason: string };

export const NOT_OPEN = 'Metro is not open to this account.';
export const WAITING = 'You are on the waitlist already. We will let you in soon.';
export const NO_ACCOUNT = 'No Metro account for this email yet. Join the waitlist first.';

const letIn = (status: UserStatus | null, t: Tokens): boolean => status === 'approved' || isOperatorEmail(t.user.email) || t.organization !== null;

export async function admit(users: UserStore, t: Tokens, intent: Intent, at: string): Promise<Admission> {
  const status = (await users.find(t.user.id))?.status ?? null;
  await users.noteLogin(t.user, at);
  if (status === 'rejected') return { kind: 'refused', reason: NOT_OPEN };
  if (letIn(status, t)) {
    if (status !== 'approved') await users.setStatus(t.user.id, 'approved');
    return { kind: 'in' };
  }
  if (intent === 'waitlist') {
    if (status === null) await users.setStatus(t.user.id, 'waitlist');
    return { kind: 'waiting' };
  }
  return { kind: 'refused', reason: status === 'waitlist' ? WAITING : NO_ACCOUNT };
}

export async function stillIn(users: UserStore, t: Tokens): Promise<boolean> {
  const status = (await users.find(t.user.id))?.status ?? null;
  return status !== 'rejected' && letIn(status, t);
}
