import { readJson, writeSecure } from '@metro-labs/core/secure-fs';
import { accountFiles } from '@metro-labs/core/stations/account-files';
import { seenOf } from '@metro-labs/core/stations/mail';
import { tokenStateOf, type Tokens } from '@metro-labs/core/stations/oauth';

export interface AccountState extends Tokens {
  deltaLink: string | null;
  syncedAt: string | null;
  seen: string[];
}

export const stateFiles = accountFiles('OUTLOOK_STATE_DIR', 'outlook-state-');

const nullable = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

export function loadState(accountId: string, seed: Partial<Tokens>): AccountState {
  const saved = readJson<Record<string, unknown>>(stateFiles.path(accountId), {});
  return {
    ...tokenStateOf(saved, seed),
    deltaLink: nullable(saved.deltaLink),
    syncedAt: nullable(saved.syncedAt),
    seen: seenOf(saved.seen),
  };
}

export function saveState(accountId: string, state: AccountState): void {
  writeSecure(stateFiles.path(accountId), JSON.stringify(state));
}
