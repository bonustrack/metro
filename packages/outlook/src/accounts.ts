import { makeAccountStore, resolveAccountId, type Die } from '@metro-labs/core/stations/account-store';
import { threadOfLine } from '@metro-labs/core/stations/mail';
import { TokenKeeper, type FetchLike } from '@metro-labs/core/stations/oauth';
import { TrainError } from '@metro-labs/core/train-error';
import { refreshTokens } from './auth.js';
import { loadState, saveState, type AccountState } from './state.js';

export interface AccountConfig {
  id: string;
  accountEmail: string;
  refreshToken: string;
  accessToken?: string;
  expiresAt?: number;
  includeAutomated?: boolean;
}

function checkAccount(a: AccountConfig, die: Die): void {
  if (typeof a.accountEmail !== 'string' || !a.accountEmail.includes('@')) die(`account '${a.id}' has no mailbox address`);
  if (typeof a.refreshToken !== 'string' || a.refreshToken === '') die(`account '${a.id}' has no refresh token`);
}

export const { loadAccounts } = makeAccountStore<AccountConfig>({
  prefix: 'outlook',
  validate(raw, die) {
    for (const a of raw) checkAccount(a, die);
  },
});

const signedOut = (err: unknown): never => {
  throw new TrainError('outlook_signed_out', err instanceof Error ? err.message : String(err), { retryable: false });
};

export class Account {
  readonly email: string;
  readonly state: AccountState;
  private readonly keeper: TokenKeeper;

  constructor(
    readonly cfg: AccountConfig,
    private readonly fetchImpl: FetchLike = (input, init) => fetch(input, init),
  ) {
    this.email = cfg.accountEmail.toLowerCase();
    this.state = loadState(cfg.id, { refreshToken: cfg.refreshToken, accessToken: cfg.accessToken ?? '', expiresAt: cfg.expiresAt ?? 0 });
    this.keeper = new TokenKeeper(this.state, (refreshToken) => refreshTokens(refreshToken, this.fetchImpl).catch(signedOut), () => {
      this.save();
    });
  }

  get id(): string {
    return this.cfg.id;
  }

  save(): void {
    saveState(this.cfg.id, this.state);
  }

  token(force = false): Promise<string> {
    return this.keeper.token(force);
  }

  fetch(input: string, init?: RequestInit): Promise<Response> {
    return this.fetchImpl(input, init);
  }
}

export const accounts = new Map<string, Account>();

function accountFor(id: string): Account {
  const acct = accounts.get(id);
  if (!acct) throw new Error(`unknown account '${id}' (have: ${[...accounts.keys()].join(', ')})`);
  return acct;
}

export function accountOf(args: { account?: unknown; line?: unknown }): Account {
  const line = typeof args.line === 'string' && args.line !== '' ? args.line : undefined;
  const account = typeof args.account === 'string' && args.account !== '' ? args.account : undefined;
  return accountFor(resolveAccountId(accounts, { account, line }, (l) => threadOfLine('outlook', l)?.accountId));
}
