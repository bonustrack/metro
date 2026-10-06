import { makeAccountStore, resolveAccountId, type Die } from '@metro-labs/core/stations/account-store';
import { threadOfLine } from '@metro-labs/core/stations/mail';
import { TokenKeeper, type FetchLike } from '@metro-labs/core/stations/oauth';
import { TrainError } from '@metro-labs/core/train-error';
import { refreshTokens } from './auth.js';
import { renewManaged, revokeManaged } from './managed.js';
import { checkManagedBinding, type ManagedBinding } from './managed-binding.js';
import { loadState, saveState, type AccountState } from './state.js';

export interface AccountConfig extends ManagedBinding {
  id: string;
  accountEmail: string;
  clientId?: string;
  clientSecret?: string;
  refreshGrant?: string;
  authorizationId?: string;
  sendEnabled?: boolean;
  refreshToken: string;
  accessToken?: string;
  expiresAt?: number;
  includeAutomated?: boolean;
}

const filled = (v: unknown): boolean => typeof v === 'string' && v !== '';

function checkClient(a: AccountConfig, die: Die): void {
  if (a.managed === true) {
    if (!filled(a.refreshGrant) || !filled(a.managedHost) || !filled(a.managedOrganization) || !filled(a.authorizationId) || typeof a.sendEnabled !== 'boolean') die(`account '${a.id}' has an incomplete managed sign-in`);
  } else if (!filled(a.clientId) || !filled(a.clientSecret)) die(`account '${a.id}' has no OAuth client`);
}

function checkAccount(a: AccountConfig, die: Die): void {
  if (!filled(a.accountEmail) || !a.accountEmail.includes('@')) die(`account '${a.id}' has no mailbox address`);
  checkClient(a, die);
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
  private readonly pendingTokens = new Set<Promise<string>>();
  private closing = false;
  private revoked = false;

  constructor(
    readonly cfg: AccountConfig,
    private readonly fetchImpl: FetchLike = (input, init) => fetch(input, init),
  ) {
    this.email = cfg.accountEmail.toLowerCase();
    this.state = loadState(cfg.id, cfg);
    const client = { clientId: cfg.clientId ?? '', clientSecret: cfg.clientSecret ?? '' };
    this.keeper = new TokenKeeper(this.state, async (refreshToken) => {
      checkManagedBinding(cfg);
      const tokens = await (cfg.managed === true
        ? renewManaged(refreshToken, this.state.refreshGrant ?? '', cfg.managedHost ?? '', this.fetchImpl)
        : refreshTokens(client, refreshToken, this.fetchImpl, Date.now(), cfg.sendEnabled)).catch(signedOut);
      return tokens;
    }, () => {
      this.save();
    });
  }

  get id(): string {
    return this.cfg.id;
  }

  save(): void {
    saveState(this.cfg.id, this.state);
  }

  check(): void {
    if (this.closing) throw new TrainError('gmail_disconnecting', 'This Gmail connection is disconnecting.', { retryable: false });
    checkManagedBinding(this.cfg);
  }

  async token(force = false): Promise<string> {
    this.check();
    const pending = this.keeper.token(force);
    this.pendingTokens.add(pending);
    try {
      const token = await pending;
      this.check();
      return token;
    } finally {
      this.pendingTokens.delete(pending);
    }
  }

  async disconnect(authorizationId: unknown): Promise<void> {
    if (this.cfg.managed !== true || !authorizationId || authorizationId !== this.cfg.authorizationId) throw new TrainError('gmail_connection_changed', 'This Gmail connection changed. Try deleting again.', { retryable: false });
    if (this.revoked) return;
    if (this.closing) throw new TrainError('gmail_disconnecting', 'This Gmail connection is disconnecting.', { retryable: false });
    this.closing = true;
    try {
      await Promise.allSettled([...this.pendingTokens]);
      await revokeManaged(this.state.refreshToken, this.state.refreshGrant ?? '', this.cfg.managedHost ?? '', this.fetchImpl);
      this.revoked = true;
    } catch (err) {
      this.closing = false;
      throw err;
    }
  }

  async fetch(input: string, init?: RequestInit): Promise<Response> {
    this.check();
    const result = await this.fetchImpl(input, init);
    this.check();
    return result;
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
