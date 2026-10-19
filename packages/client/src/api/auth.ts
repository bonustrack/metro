import { builtInDaemon } from '../auth/daemon.js';
import { fetchNoRedirect, signInReturnUrl, timeoutSignal } from '../platform.js';
import {
  AccountChangedError,
  accountFrom,
  accountScopeIdentity,
  accountSessionIdentity,
  activeAccount,
  beginAccountLogout,
  clearAccount,
  keepOrganizationAccount,
  keepRefreshToken,
  organizationAccount,
  selectAccount,
  storeAccount,
  tokenExpiring,
  tokenMatchesAccount,
  withAccountLock,
  type Account,
} from '../auth/account.js';
import { isRecord, pngAvatar } from '../read.js';
import { clearInvitation, pendingInvitation } from '../auth/invitation.js';

export type Provider = 'google' | 'microsoft' | 'github';
export const PROVIDERS: Provider[] = ['google', 'microsoft', 'github'];

const authUrl = (path: string): string => `${builtInDaemon()}/api/auth${path}`;
const unexpected = (): Error => new Error('Metro returned an unexpected response.');

class AuthResponseError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export class AuthUnavailableError extends Error {}

export const switchRefused = (err: unknown): err is Error => err instanceof AuthResponseError && [401, 403, 404].includes(err.status);

function errorText(body: unknown, status: number): string {
  return isRecord(body) && typeof body.error === 'string' ? body.error : `Metro returned ${String(status)}.`;
}

async function post(path: string, body: unknown, bearer?: string, controls?: Pick<RequestInit, 'signal'>): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchNoRedirect(authUrl(path), {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(bearer === undefined ? {} : { authorization: `Bearer ${bearer}` }) },
      body: JSON.stringify(body),
      ...controls,
    });
  } catch {
    throw new AuthUnavailableError('Failed to reach Metro.');
  }
  const answer: unknown = await res.json().catch((err: unknown) => {
    if (res.ok && !(err instanceof SyntaxError)) throw new AuthUnavailableError('Failed to reach Metro.');
    return null;
  });
  if (!res.ok) throw new AuthResponseError(errorText(answer, res.status), res.status);
  return answer;
}

export const returnTo = (): string => signInReturnUrl();

export type Intent = 'login' | 'waitlist';

export interface AppReturn {
  returnTo: string;
  challenge: string;
}

export function loginUrl(provider: Provider, intent: Intent, app?: AppReturn): string {
  const invitation = pendingInvitation();
  const extra = `${intent === 'waitlist' ? '&intent=waitlist' : ''}${invitation === null ? '' : `&invitation_token=${encodeURIComponent(invitation)}`}`;
  const back = app === undefined ? '' : `&code_challenge=${encodeURIComponent(app.challenge)}`;
  return authUrl(`/login?provider=${provider}&return_to=${encodeURIComponent(app?.returnTo ?? returnTo())}${extra}${back}`);
}

export async function sendEmailCode(email: string, intent: Intent): Promise<void> {
  const invitation = pendingInvitation();
  await post('/email/start', { email, intent, ...(invitation === null ? {} : { invitation }) });
}

export async function verifyEmailCode(email: string, code: string, intent: Intent): Promise<string> {
  const invitation = pendingInvitation();
  const answer = await post('/email/verify', { email, code, intent, ...(invitation === null ? {} : { invitation }) });
  if (!isRecord(answer) || typeof answer.hash !== 'string' || !answer.hash.startsWith('#/')) throw unexpected();
  return answer.hash;
}

export async function exchangeHandoff(code: string, verifier?: string): Promise<Account> {
  const scope = accountScopeIdentity();
  const account = accountFrom(await post('/exchange', verifier === undefined ? { code } : { code, verifier }));
  return withAccountLock(() => {
    if (accountScopeIdentity() !== scope) throw new AccountChangedError();
    storeAccount(account);
    clearInvitation();
    return Promise.resolve(account);
  });
}

let serialized: Promise<void> = Promise.resolve();
let refreshing: { scope: number; pending: Promise<Account | null> } | null = null;

const rotate = (path: string, body: unknown, bearer?: string): Promise<unknown> => post(path, body, bearer, { signal: timeoutSignal(30_000) });
const usable = (account: Account): boolean => tokenMatchesAccount(account) && !tokenExpiring(account.accessToken);

function currentAccount(scope: number): Account {
  const current = activeAccount();
  if (accountScopeIdentity() !== scope) throw new AccountChangedError();
  if (current === null) throw new Error('Log in first.');
  return current;
}

function sameSession(session: number): number {
  if (accountSessionIdentity() !== session) throw new AccountChangedError();
  return accountScopeIdentity();
}

function serialize<T>(run: () => Promise<T>): Promise<T> {
  const pending = serialized.then(() => withAccountLock(run));
  serialized = pending.then(() => undefined, () => undefined);
  return pending;
}

async function refreshCurrent(scope: number, seen: string | null): Promise<Account | null> {
  const current = currentAccount(scope);
  if (seen !== null && current.accessToken !== seen && usable(current)) return current;
  try {
    const next = accountFrom(await rotate('/refresh', { refreshToken: current.refreshToken, ...(current.organization === null ? {} : { organization: current.organization }) }));
    if (!sameSource(next, current)) throw unexpected();
    storeAccount(next, scope);
    return next;
  } catch (err) {
    return refreshFailed(err, scope);
  }
}

function refreshFailed(err: unknown, scope: number): null {
  if (accountScopeIdentity() !== scope) throw new AccountChangedError();
  if (err instanceof AuthUnavailableError) throw err;
  if (err instanceof AuthResponseError && err.status !== 401) throw new AuthUnavailableError(err.message);
  clearAccount();
  return null;
}

export function refreshAccount(): Promise<Account | null> {
  const current = activeAccount();
  if (current === null) return Promise.resolve(null);
  const scope = accountScopeIdentity();
  if (refreshing?.scope === scope) return refreshing.pending;
  const pending = serialize(() => refreshCurrent(scope, current.accessToken)).finally(() => {
    if (refreshing?.pending === pending) refreshing = null;
  });
  refreshing = { scope, pending };
  return pending;
}

export async function accessToken(): Promise<string | null> {
  const scope = accountScopeIdentity();
  const current = activeAccount();
  if (current === null) return null;
  const next = tokenExpiring(current.accessToken) ? await refreshAccount() : current;
  if (accountScopeIdentity() !== scope && (next !== null || activeAccount() !== null)) throw new AccountChangedError();
  return next !== null && !tokenExpiring(next.accessToken) ? next.accessToken : null;
}

async function freshAccount(scope: number): Promise<Account> {
  let current = currentAccount(scope);
  if (tokenExpiring(current.accessToken)) {
    if (await refreshCurrent(scope, null) === null) throw new Error('Could not refresh your session. Sign in again.');
    current = currentAccount(scope);
  }
  if (!usable(current)) throw new Error('Your access token has expired. Sign in again.');
  return current;
}

const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

function rotated(answer: unknown, current: Account, scope: number, organization?: string): Account {
  try {
    const next = accountFrom(answer);
    if (!tokenMatchesAccount(next) || next.user.id !== current.user.id || (organization !== undefined && next.organization !== organization)) throw unexpected();
    return next;
  } catch (err) {
    const refreshToken = isRecord(answer) ? text(answer.refreshToken) : null;
    if (refreshToken !== null && refreshToken !== current.refreshToken) keepRefreshToken(refreshToken, scope);
    throw err;
  }
}

function selectOrganization(path: string, body: Record<string, string>, organization?: string): Promise<Account> {
  const session = accountSessionIdentity();
  return serialize(async () => {
    const scope = sameSession(session);
    if (organization !== undefined) {
      if (currentAccount(scope).organization === organization) return freshAccount(scope);
      const cached = organizationAccount(organization);
      if (cached !== null) {
        selectAccount(cached, scope);
        return cached;
      }
    }
    const current = await freshAccount(scope);
    const next = rotated(await rotate(path, { ...body, refreshToken: current.refreshToken }, current.accessToken), current, scope, organization);
    selectAccount(next, scope);
    return next;
  });
}

export const createOrganization = (name: string): Promise<Account> => selectOrganization('/organization', { name });

export const switchOrganization = (organization: string): Promise<Account> => selectOrganization('/switch', { organization }, organization);

export interface OrgAgent {
  id: string;
  host: string;
  name: string | null;
  slug: string | null;
  avatar: string | null;
}

export interface OrganizationRow {
  id: string;
  name: string | null;
  role: string | null;
  slug: string | null;
  avatar: string | null;
  agents: OrgAgent[] | null;
}

function agentsOf(value: unknown): OrgAgent[] | null {
  if (!Array.isArray(value)) return null;
  return value.flatMap((a: unknown) =>
    isRecord(a) && typeof a.id === 'string' && typeof a.host === 'string'
      ? [{ id: a.id, host: a.host, name: text(a.name), slug: text(a.slug), avatar: pngAvatar(a.avatar) }]
      : [],
  );
}

async function sessionBearer(session: number): Promise<string> {
  for (let attempt = 0; ; attempt += 1) {
    sameSession(session);
    try {
      const bearer = await accessToken();
      sameSession(session);
      if (bearer === null) throw new Error('Log in first.');
      return bearer;
    } catch (err) {
      if (!(err instanceof AccountChangedError) || attempt >= 2 || accountSessionIdentity() !== session) throw err;
    }
  }
}

export async function fetchOrganizations(): Promise<OrganizationRow[]> {
  const session = accountSessionIdentity();
  const bearer = await sessionBearer(session);
  const res = await fetch(authUrl('/organizations'), { headers: { authorization: `Bearer ${bearer}` } });
  const body: unknown = await res.json().catch(() => null);
  sameSession(session);
  if (!res.ok) throw new Error(errorText(body, res.status));
  return toOrganizations(body);
}

export function toOrganizations(body: unknown): OrganizationRow[] {
  if (!isRecord(body) || !Array.isArray(body.organizations)) throw unexpected();
  return body.organizations.flatMap((o: unknown) =>
    isRecord(o) && typeof o.id === 'string'
      ? [{ id: o.id, name: typeof o.name === 'string' ? o.name : null, role: typeof o.role === 'string' ? o.role : null, slug: typeof o.slug === 'string' ? o.slug : null, avatar: pngAvatar(o.avatar), agents: agentsOf(o.agents) }]
      : [],
  );
}

const sameSource = (next: Account, current: Account): boolean => tokenMatchesAccount(next) && next.user.id === current.user.id && next.organization === current.organization;

function organizationToken(session: number, organization: string, check: () => void): Promise<string> {
  return serialize(async () => {
    check();
    const scope = sameSession(session);
    currentAccount(scope);
    const cached = organizationAccount(organization);
    if (cached !== null) return cached.accessToken;
    const current = await freshAccount(scope);
    if (current.organization === organization) return current.accessToken;
    if (current.organization === null) throw new Error('Select a source organization first.');
    check();
    const next = rotated(await rotate('/switch', { organization, refreshToken: current.refreshToken }, current.accessToken), current, scope, organization);
    keepOrganizationAccount(next, scope);
    if (tokenExpiring(next.accessToken)) throw new Error('The organization access token has expired. Try again.');
    return next.accessToken;
  });
}

const scopedTokens = new Map<string, { pending: Promise<string>; signals: (AbortSignal | undefined)[] }>();
const cancelled = (): Error => Object.assign(new Error('The request was cancelled.'), { name: 'AbortError' });

function checkCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw cancelled();
}

function subscribedToken(pending: Promise<string>, signal?: AbortSignal): Promise<string> {
  if (signal === undefined) return pending;
  let abort = (): void => undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    abort = () => { reject(cancelled()); };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
  return Promise.race([pending, aborted]).finally(() => { signal.removeEventListener('abort', abort); });
}

export async function scopedOrganizationAccessToken(organization: string, options: { signal?: AbortSignal } = {}): Promise<string> {
  checkCancelled(options.signal);
  const session = accountSessionIdentity();
  currentAccount(accountScopeIdentity());
  const cached = organizationAccount(organization);
  if (cached !== null) return cached.accessToken;
  const key = `${String(session)}:${organization}`;
  let flight = scopedTokens.get(key);
  if (flight === undefined) {
    const signals: (AbortSignal | undefined)[] = [];
    const pending = organizationToken(session, organization, () => {
      if (signals.every((signal) => signal?.aborted)) throw cancelled();
    }).finally(() => { scopedTokens.delete(key); });
    flight = { pending, signals };
    scopedTokens.set(key, flight);
  }
  flight.signals.push(options.signal);
  const token = await subscribedToken(flight.pending, options.signal);
  checkCancelled(options.signal);
  sameSession(session);
  if (tokenExpiring(token)) throw new Error('The organization access token has expired. Try again.');
  return token;
}

export async function updateAccount(changes: { name?: string; avatar?: string | null }): Promise<Account | null> {
  const scope = accountScopeIdentity();
  const bearer = await accessToken();
  currentAccount(scope);
  if (bearer === null) throw new Error('Log in first.');
  let res: Response;
  try {
    res = await fetch(authUrl('/account'), { method: 'PUT', headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` }, body: JSON.stringify(changes) });
  } catch {
    throw new Error('Failed to reach Metro.');
  }
  const answer: unknown = await res.json().catch(() => null);
  if (!res.ok) throw new Error(errorText(answer, res.status));
  currentAccount(scope);
  return refreshAccount();
}

export async function logoutAccount(): Promise<void> {
  const current = activeAccount();
  const scope = beginAccountLogout();
  await withAccountLock(() => {
    if (accountScopeIdentity() === scope) clearAccount();
    return Promise.resolve();
  });
  if (current !== null) await post('/logout', {}, current.accessToken).catch(() => undefined);
}
