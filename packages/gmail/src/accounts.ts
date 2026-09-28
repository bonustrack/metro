import { makeAccountStore, resolveAccountId, type Die } from '@metro-labs/core/stations/account-store';
import { threadOfLine } from '@metro-labs/core/stations/mail';
import { TokenKeeper, type FetchLike } from '@metro-labs/core/stations/oauth';
import { TrainError } from '@metro-labs/core/train-error';
import { refreshTokens } from './auth.js';
import { loadState, saveState, type AccountState } from './state.js';

export interface AccountConfig {
  id: string;
  accountEmail: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  accessToken?: string;
  expiresAt?: number;
  includeAutomated?: boolean;
}

const filled = (v: unknown): boolean => typeof v === 'string' && v !== '';

function checkAccount(a: AccountConfig, die: Die): void {
  if (!filled(a.accountEmail) || !a.accountEmail.includes('@')) die(`account '${a.id}' has no mailbox address`);
  if (!filled(a.clientId) || !filled(a.clientSecret)) die(`account '${a.id}' has no OAuth client`);
  if (!filled(a.refreshToken)) die(`account '${a.id}' has no refresh token`);
}

export const { loadAccounts } = makeAccountStore<AccountConfig>({
  prefix: 'gmail',
  validate(raw, die) {
    for (const a of raw) checkAccount(a, die);
  },
});

const signedOut = (err: unknown): never => {
  throw new TrainError('gmail_signed_out', err instanceof Error ? err.message : String(err), { retryable: false });
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
    const client = { clientId: cfg.clientId, clientSecret: cfg.clientSecret };
    this.keeper = new TokenKeeper(this.state, (refreshToken) => refreshTokens(client, refreshToken, this.fetchImpl).catch(signedOut), () => {
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

export function accountOf(args: { account?: unknown; line?: unknown }): Account {
  const line = typeof args.line === 'string' && args.line !== '' ? args.line : undefined;
  const account = typeof args.account === 'string' && args.account !== '' ? args.account : undefined;
  const id = resolveAccountId(accounts, { account, line }, (l) => threadOfLine('gmail', l)?.accountId);
  const acct = accounts.get(id);
  if (acct === undefined) throw new Error(`unknown account '${id}'`);
  return acct;
}
