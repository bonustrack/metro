import { makeAccountStore, resolveAccountId, type Die } from '@metro-labs/core/stations/account-store';
import { TrainError } from '@metro-labs/core/train-error';
import { refreshTokens, type FetchLike } from './auth.js';
import { conversationOfLine } from './format.js';
import { loadState, saveState, type AccountState } from './state.js';

const RENEW_BEFORE_MS = 5 * 60_000;

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

export class Account {
  readonly email: string;
  readonly state: AccountState;
  private refreshing: Promise<string> | null = null;

  constructor(
    readonly cfg: AccountConfig,
    private readonly fetchImpl: FetchLike = (input, init) => fetch(input, init),
  ) {
    this.email = cfg.accountEmail.toLowerCase();
    this.state = loadState(cfg.id, {
      refreshToken: cfg.refreshToken,
      accessToken: cfg.accessToken ?? '',
      expiresAt: cfg.expiresAt ?? 0,
    });
  }

  get id(): string {
    return this.cfg.id;
  }

  save(): void {
    saveState(this.cfg.id, this.state);
  }

  token(force = false): Promise<string> {
    const fresh = this.state.accessToken !== '' && this.state.expiresAt - RENEW_BEFORE_MS > Date.now();
    if (fresh && !force) return Promise.resolve(this.state.accessToken);
    this.refreshing ??= this.renew().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async renew(): Promise<string> {
    let tokens;
    try {
      tokens = await refreshTokens(this.state.refreshToken, this.fetchImpl);
    } catch (err) {
      throw new TrainError('outlook_signed_out', err instanceof Error ? err.message : String(err), { retryable: false });
    }
    Object.assign(this.state, tokens);
    this.save();
    return tokens.accessToken;
  }

  fetch(input: string, init?: RequestInit): Promise<Response> {
    return this.fetchImpl(input, init);
  }
}

export const accounts = new Map<string, Account>();

export function accountFor(id: string): Account {
  const acct = accounts.get(id);
  if (!acct) throw new Error(`unknown account '${id}' (have: ${[...accounts.keys()].join(', ')})`);
  return acct;
}

export function accountOf(args: { account?: unknown; line?: unknown }): Account {
  const line = typeof args.line === 'string' && args.line !== '' ? args.line : undefined;
  const account = typeof args.account === 'string' && args.account !== '' ? args.account : undefined;
  return accountFor(resolveAccountId(accounts, { account, line }, (l) => conversationOfLine(l)?.accountId));
}
