import { homedir } from 'node:os';
import { join } from 'node:path';
import { readJson, writeSecure } from '@metro-labs/core/secure-fs';

export interface AccountState {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  deltaLink: string | null;
  syncedAt: string | null;
  seen: string[];
}

const SEEN_MAX = 500;

const safeSegment = (s: string): string => s.replace(/[^A-Za-z0-9_-]/g, '_');

export function statePath(accountId: string): string {
  const dir = process.env.OUTLOOK_STATE_DIR ?? join(homedir(), '.metro');
  return join(dir, `outlook-state-${safeSegment(accountId)}.json`);
}

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
    deltaLink: nullable(saved.deltaLink) ?? seed.deltaLink ?? null,
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
