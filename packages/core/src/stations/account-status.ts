import { isRecord } from '../is-record.js';

const ACCOUNT_STATES = ['connected', 'connecting', 'logged_out', 'disconnected'] as const;

export type AccountState = (typeof ACCOUNT_STATES)[number];

export interface AccountStatus {
  state: AccountState;
  reason?: string;
  since: number;
}

const REASON_MAX = 300;

export function accountStatus(state: AccountState, reason?: string, since = Date.now()): AccountStatus {
  const text = reason?.trim().slice(0, REASON_MAX) ?? '';
  return text === '' ? { state, since } : { state, reason: text, since };
}

export function accountStatusOf(raw: unknown): AccountStatus | null {
  if (!isRecord(raw)) return null;
  const state = ACCOUNT_STATES.find((s) => s === raw.state);
  const since = raw.since;
  if (state === undefined || typeof since !== 'number' || !Number.isFinite(since)) return null;
  return accountStatus(state, typeof raw.reason === 'string' ? raw.reason : undefined, since);
}
