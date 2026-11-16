import { filled } from '@metro-labs/http/workos-token';
import type { UserLogin, UserStore, UserStatus } from '../users.js';
import type { AccountsMode } from './accounts-mode.js';

const OPERATOR_EMAIL = 'admin@stage.box';

export interface Person {
  id: string;
  email: string | null;
}

export function isOperator(person: Person | null, mode: AccountsMode, env: NodeJS.ProcessEnv = process.env): boolean {
  if (person === null) return false;
  const id = filled(env.OPERATOR_USER_ID);
  if (id !== null && person.id === id) return true;
  return mode === 'workos' && person.email?.toLowerCase() === OPERATOR_EMAIL;
}

export type Intent = 'login' | 'waitlist';

export type Refusal = 'no-account' | 'waiting' | 'not-open' | 'unverified' | 'other-account' | 'cancelled' | 'failed';

export interface Arrival {
  user: UserLogin;
  organization: string | null;
}

type Admission = { kind: 'in' } | { kind: 'waiting' } | { kind: 'refused'; reason: Refusal };

const letIn = (status: UserStatus | null, t: Arrival, mode: AccountsMode): boolean => status === 'approved' || isOperator(t.user, mode) || t.organization !== null;

export async function admit(users: UserStore, t: Arrival, intent: Intent, at: string, mode: AccountsMode): Promise<Admission> {
  const status = (await users.find(t.user.id))?.status ?? null;
  await users.noteLogin(t.user, at);
  if (status === 'rejected') return { kind: 'refused', reason: 'not-open' };
  if (letIn(status, t, mode)) {
    if (status !== 'approved' && isOperator(t.user, mode)) await users.setStatus(t.user.id, 'approved');
    return { kind: 'in' };
  }
  if (intent === 'waitlist') {
    if (status === null) await users.setStatus(t.user.id, 'waitlist');
    return { kind: 'waiting' };
  }
  return { kind: 'refused', reason: status === 'waitlist' ? 'waiting' : 'no-account' };
}

export async function mayCreateOrganization(users: UserStore, user: string, mode: AccountsMode): Promise<boolean> {
  const record = await users.find(user);
  return record?.status === 'approved' || isOperator(record ?? { id: user, email: null }, mode);
}

export async function stillIn(users: UserStore, t: Arrival, mode: AccountsMode): Promise<boolean> {
  const status = (await users.find(t.user.id))?.status ?? null;
  return status !== 'rejected' && letIn(status, t, mode);
}
