import { readJson, writeSecure } from '@metro-labs/core/secure-fs';
import { accountFiles } from '@metro-labs/core/stations/account-files';

export interface AccountState {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  deltaLink: string | null;
  syncedAt: string | null;
  seen: string[];
}

const SEEN_MAX = 500;

export const stateFiles = accountFiles('OUTLOOK_STATE_DIR', 'outlook-state-');

const statePath =(accountId: string): string => stateFiles.path(accountId);

const text = (v: unknown): string => (typeof v === 'string' ? v : '');
const nullable = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

export function loadState(accountId: string, seed: Partial<AccountState>): AccountState {
  const saved = readJson<Record<string, unknown>>(statePath(accountId), {});
  const refreshToken = text(saved.refreshToken) || text(seed.refreshToken);
  const fromFile = text(saved.refreshToken) !== '';
  return {
    refreshToken,
    accessToken: fromFile ? text(saved.accessToken) : text(seed.accessToken),
    expiresAt: fromFile ? Number(saved.expiresAt) || 0 : Number(seed.expiresAt) || 0,
    deltaLink: nullable(saved.deltaLink),
    syncedAt: nullable(saved.syncedAt),
    seen: Array.isArray(saved.seen) ? saved.seen.filter((s): s is string => typeof s === 'string') : [],
  };
}

export function saveState(accountId: string, state: AccountState): void {
  writeSecure(statePath(accountId), JSON.stringify(state));
}

export function noteSeen(state: AccountState, messageId: string): void {
  state.seen.push(messageId);
  if (state.seen.length > SEEN_MAX) state.seen.splice(0, state.seen.length - SEEN_MAX);
}
