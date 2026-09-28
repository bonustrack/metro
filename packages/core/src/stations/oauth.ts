import { createHash, randomBytes } from 'node:crypto';

export class SignInError extends Error {}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type OAuthBody = Record<string, unknown>;

export interface Tokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

export interface Pkce {
  verifier: string;
  challenge: string;
}

const RENEW_BEFORE_MS = 5 * 60_000;
const MAILBOX_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const text = (v: unknown): string => (typeof v === 'string' ? v : '');

export const seconds = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback;

export function envValue(name: string, fallback: string): string {
  const value = (process.env[name] ?? '').trim();
  return value === '' ? fallback : value;
}

export const envUrl = (name: string, fallback: string): string => envValue(name, fallback).replace(/\/+$/, '');

export function pkcePair(verifier = randomBytes(32).toString('base64url')): Pkce {
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

export const newState = (): string => randomBytes(24).toString('base64url');

export function parseMailbox(value: unknown): string | null {
  const mailbox = (typeof value === 'string' ? value.trim() : '').toLowerCase();
  if (mailbox === '') return null;
  if (!MAILBOX_RE.test(mailbox))
    throw new SignInError('Type the whole address of the mailbox, like andy@company.com, or leave it blank.');
  return mailbox;
}

export async function postForm(url: string, fields: Record<string, string>, fetchImpl: FetchLike, provider: string): Promise<{ status: number; body: OAuthBody }> {
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams(fields).toString(),
    });
  } catch (err) {
    throw new SignInError(`Metro could not reach ${provider}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const raw: unknown = await res.json().catch(() => ({}));
  return { status: res.status, body: typeof raw === 'object' && raw !== null ? (raw as OAuthBody) : {} };
}

export function tokensOf(body: OAuthBody, now: number, provider: string, previous?: string): Tokens {
  const accessToken = text(body.access_token);
  const refreshToken = text(body.refresh_token) || (previous ?? '');
  if (accessToken === '' || refreshToken === '') throw new SignInError(`${provider} answered without the tokens Metro needs.`);
  return { accessToken, refreshToken, expiresAt: now + seconds(body.expires_in, 3600) * 1000 };
}

export function tokenStateOf(saved: OAuthBody, seed: Partial<Tokens>): Tokens {
  const fromFile = text(saved.refreshToken) !== '';
  return {
    refreshToken: fromFile ? text(saved.refreshToken) : text(seed.refreshToken),
    accessToken: fromFile ? text(saved.accessToken) : text(seed.accessToken),
    expiresAt: fromFile ? Number(saved.expiresAt) || 0 : Number(seed.expiresAt) || 0,
  };
}

export class TokenKeeper {
  private refreshing: Promise<string> | null = null;

  constructor(
    private readonly state: Tokens,
    private readonly renewWith: (refreshToken: string) => Promise<Tokens>,
    private readonly renewed: () => void,
  ) {}

  token(force = false): Promise<string> {
    const fresh = this.state.accessToken !== '' && this.state.expiresAt - RENEW_BEFORE_MS > Date.now();
    if (fresh && !force) return Promise.resolve(this.state.accessToken);
    this.refreshing ??= this.renew().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async renew(): Promise<string> {
    Object.assign(this.state, await this.renewWith(this.state.refreshToken));
    this.renewed();
    return this.state.accessToken;
  }
}

export interface BrowserFlow<R> {
  authorize: (challenge: string, state: string) => string;
  redeem: (code: string, verifier: string) => Promise<R>;
}

export class BrowserSignIn<R> {
  readonly state = newState();
  readonly authorizeUrl: string;
  private readonly pkce = pkcePair();
  private used = false;

  constructor(private readonly flow: BrowserFlow<R>) {
    this.authorizeUrl = flow.authorize(this.pkce.challenge, this.state);
  }

  async finish(code: string, state: string): Promise<R> {
    if (state !== this.state) throw new SignInError('This sign-in link belongs to another attempt. Start again from the Channels page.');
    if (this.used) throw new SignInError('This sign-in was already used. Start again from the Channels page.');
    this.used = true;
    return this.flow.redeem(code, this.pkce.verifier);
  }
}
