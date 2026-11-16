import { log } from '@metro-labs/core/log';
import { filled } from '@metro-labs/http/workos-token';

const USER_ID_RE = /^user_[0-9A-Z]{26}$/;

export type AccountsMode = 'workos' | 'metro';

export function readAccountsMode(env: NodeJS.ProcessEnv = process.env): AccountsMode {
  const raw = env.METRO_ACCOUNTS?.trim() ?? '';
  if (raw === 'metro') return 'metro';
  if (raw !== '' && raw !== 'workos') log.warn({ value: raw }, 'api: METRO_ACCOUNTS is neither workos nor metro, so WorkOS keeps the accounts');
  return 'workos';
}

const WORKOS_BUTTONS = ['google', 'microsoft', 'github'];

export const signInChoices = (mode: AccountsMode, configured: string[]): { accounts: AccountsMode; providers: string[] } => ({ accounts: mode, providers: mode === 'metro' ? configured : WORKOS_BUTTONS });

export function announceAccounts(mode: AccountsMode, providers: string[], signing: boolean, env: NodeJS.ProcessEnv = process.env): void {
  if (mode === 'workos') {
    log.info({ accounts: mode }, 'api: accounts: WorkOS keeps the users, organizations and members (METRO_ACCOUNTS is not metro)');
    return;
  }
  log.info({ accounts: mode, providers, signing }, 'api: accounts: Metro keeps the users, organizations and members');
  if (providers.length === 0) log.warn('api: no sign-in provider is set up: GOOGLE_OAUTH_CLIENT_ID and _SECRET, MICROSOFT_OAUTH_CLIENT_ID and _SECRET are unset');
  if (!signing) log.warn('api: METRO_AUTH_SIGNING_KEY is unset, so nobody can sign in');
  if (!USER_ID_RE.test(filled(env.OPERATOR_USER_ID) ?? '')) log.warn('api: OPERATOR_USER_ID is unset or not a user id (user_ and 26 characters), so nobody is the operator');
}
