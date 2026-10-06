import { readJson, writeSecure } from '@metro-labs/core/secure-fs';
import { accountFiles } from '@metro-labs/core/stations/account-files';
import { seenOf } from '@metro-labs/core/stations/mail';
import { tokenStateOf, type Tokens } from '@metro-labs/core/stations/oauth';

export interface AccountState extends Tokens {
  refreshGrant?: string;
  authorizationId?: string;
  historyId: string | null;
  seen: string[];
}

export const stateFiles = accountFiles('GMAIL_STATE_DIR', 'gmail-state-');

export function loadState(accountId: string, seed: Partial<AccountState>): AccountState {
  const saved = readJson<Record<string, unknown>>(stateFiles.path(accountId), {});
  const same = saved.authorizationId === seed.authorizationId;
  const held = same ? saved : {};
  return {
    ...tokenStateOf(held, seed),
    refreshGrant: typeof held.refreshGrant === 'string' ? held.refreshGrant : seed.refreshGrant,
    authorizationId: seed.authorizationId,
    historyId: typeof saved.historyId === 'string' && saved.historyId !== '' ? saved.historyId : null,
    seen: seenOf(saved.seen),
  };
}

export function saveState(accountId: string, state: AccountState): void {
  writeSecure(stateFiles.path(accountId), JSON.stringify(state));
}
