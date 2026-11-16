import { filled } from '@metro-labs/http/workos-token';
import type { UserLogin, UserStore, UserStatus } from '../users.js';

const OPERATOR_EMAIL = 'admin@stage.box';

export interface Person {
  id: string;
  email: string | null;
}

export function isOperator(person: Person | null, env: NodeJS.ProcessEnv = process.env): boolean {
  if (person === null) return false;
  const id = filled(env.OPERATOR_USER_ID);
  return person.email?.toLowerCase() === OPERATOR_EMAIL || (id !== null && person.id === id);
}

export type Intent = 'login' | 'waitlist';

export type Refusal = 'no-account' | 'waiting' | 'not-open' | 'unverified' | 'other-account' | 'cancelled' | 'failed';

export interface Arrival {
  user: UserLogin;
  organization: string | null;
}

type Admission = { kind: 'in' } | { kind: 'waiting' } | { kind: 'refused'; reason: Refusal };

const letIn = (status: UserStatus | null, t: Arrival): boolean => status === 'approved' || isOperator(t.user) || t.organization !== null;

export async function admit(users: UserStore, t: Arrival, intent: Intent, at: string): Promise<Admission> {
  const status = (await users.find(t.user.id))?.status ?? null;
  await users.noteLogin(t.user, at);
  if (status === 'rejected') return { kind: 'refused', reason: 'not-open' };
  if (letIn(status, t)) {
    if (status !== 'approved' && isOperator(t.user)) await users.setStatus(t.user.id, 'approved');
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
  return record?.status === 'approved' || isOperator(record ?? { id: user, email: null });
}

export async function stillIn(users: UserStore, t: Arrival): Promise<boolean> {
  const status = (await users.find(t.user.id))?.status ?? null;
  return status !== 'rejected' && letIn(status, t);
}
