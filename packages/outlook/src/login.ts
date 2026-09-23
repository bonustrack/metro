import {
  OutlookAuthError,
  pollDeviceCode,
  requestDeviceCode,
  type DeviceCode,
  type FetchLike,
  type Poll,
  type Tokens,
} from './auth.js';
import { authorizeUrl, newState, pkcePair, redeemCode, type Pkce } from './browser.js';
import { verifyMailbox, type Mailbox } from './me.js';

export { parseMailbox } from './me.js';

export { OutlookAuthError as OutlookLoginError } from './auth.js';
export { NOT_SET_UP } from './config.js';
export { failureOf } from './auth.js';

export interface OutlookLoginResult {
  config: Record<string, unknown>;
  identity: Record<string, string>;
}

export interface OutlookLoginEvents {
  onDone: (result: OutlookLoginResult) => void;
  onFailed: (message: string) => void;
}

export interface OutlookLoginDeps {
  fetch?: FetchLike;
  now?: () => number;
  mailbox?: string | null;
}

const SLOW_DOWN_MS = 5_000;

function resultOf(tokens: Tokens, tenantId: string | null, mailbox: Mailbox, now: number): OutlookLoginResult {
  return {
    config: {
      accountEmail: mailbox.email,
      refreshToken: tokens.refreshToken,
      accessToken: tokens.accessToken,
      expiresAt: tokens.expiresAt,
      tenantId,
      createdAt: new Date(now).toISOString(),
    },
    identity: { email: mailbox.email, ...(mailbox.name === '' ? {} : { name: mailbox.name }) },
  };
}

export class OutlookBrowserLogin {
  readonly state = newState();
  readonly authorizeUrl: string;
  private readonly pkce: Pkce = pkcePair();
  private used = false;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private readonly mailbox: string | null;

  constructor(deps: OutlookLoginDeps = {}) {
    this.fetchImpl = deps.fetch ?? ((input, init) => fetch(input, init));
    this.now = deps.now ?? Date.now;
    this.mailbox = deps.mailbox ?? null;
    this.authorizeUrl = authorizeUrl(this.pkce.challenge, this.state, this.mailbox);
  }

  async finish(code: string, state: string): Promise<OutlookLoginResult> {
    if (state !== this.state)
      throw new OutlookAuthError('This sign-in link belongs to another attempt. Start again from the Channels page.');
    if (this.used) throw new OutlookAuthError('This sign-in was already used. Start again from the Channels page.');
    this.used = true;
    const { tokens, tenantId } = await redeemCode(code, this.pkce.verifier, this.fetchImpl, this.now());
    return resultOf(tokens, tenantId, await verifyMailbox(tokens.accessToken, this.fetchImpl, this.mailbox), this.now());
  }
}

export class OutlookLogin {
  private code: DeviceCode | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private readonly mailbox: string | null;

  constructor(private readonly events: OutlookLoginEvents, deps: OutlookLoginDeps = {}) {
    this.fetchImpl = deps.fetch ?? ((input, init) => fetch(input, init));
    this.now = deps.now ?? Date.now;
    this.mailbox = deps.mailbox ?? null;
  }

  async start(): Promise<DeviceCode> {
    const code = await requestDeviceCode(this.fetchImpl, this.now());
    this.code = code;
    this.schedule(code.intervalMs);
    return code;
  }

  cancel(): Promise<void> {
    this.stopped = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    return Promise.resolve();
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.tick().catch((err: unknown) => {
        this.fail(err instanceof OutlookAuthError ? err.message : 'Metro could not finish the Microsoft sign-in.');
      });
    }, delayMs);
    this.timer.unref();
  }

  private fail(message: string): void {
    if (this.stopped) return;
    this.stopped = true;
    this.events.onFailed(message);
  }

  private async tick(): Promise<void> {
    const code = this.code;
    if (code === null || this.stopped) return;
    if (this.now() >= code.expiresAt) {
      this.fail('The sign-in code expired before it was used. Start again.');
      return;
    }
    await this.settle(code, await pollDeviceCode(code, this.fetchImpl, this.now()));
  }

  private async settle(code: DeviceCode, poll: Poll): Promise<void> {
    if (poll.kind === 'pending') {
      this.schedule(code.intervalMs);
      return;
    }
    if (poll.kind === 'slow_down') {
      code.intervalMs += SLOW_DOWN_MS;
      this.schedule(code.intervalMs);
      return;
    }
    if (poll.kind === 'failed') {
      this.fail(poll.message);
      return;
    }
    const mailbox = await verifyMailbox(poll.tokens.accessToken, this.fetchImpl, this.mailbox);
    if (this.stopped) return;
    this.stopped = true;
    this.events.onDone(resultOf(poll.tokens, poll.tenantId, mailbox, this.now()));
  }
}
