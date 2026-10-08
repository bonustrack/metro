import { builtInDaemon } from '../auth/daemon.js';
import { fetchNoRedirect, signInReturnUrl, timeoutSignal } from '../platform.js';
import { accountFrom, accountScopeIdentity, activeAccount, beginAccountLogout, clearAccount, storeAccount, tokenExpiring, tokenMatchesAccount, withAccountLock, type Account } from '../auth/account.js';
import { isRecord } from '../read.js';
import { clearInvitation, pendingInvitation } from '../auth/invitation.js';

export type Provider = 'google' | 'microsoft' | 'github';
export const PROVIDERS: Provider[] = ['google', 'microsoft', 'github'];

const authUrl = (path: string): string => `${builtInDaemon()}/api/auth${path}`;
const unexpected = (): Error => new Error('Metro returned an unexpected response.');

class AuthResponseError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export class AuthUnavailableError extends Error {}

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
    if (accountScopeIdentity() !== scope) throw accountChanged();
    storeAccount(account);
    clearInvitation();
    return Promise.resolve(account);
  });
}

const accountChanged = (): Error => new Error('Your account changed, try again.');
const sourceLost = (): Error => new Error('Could not restore your source session. Sign in again.');
let serialized: Promise<void> = Promise.resolve();
let rotating: { scope: number; pending: Promise<Account | null>; started: boolean } | null = null;
let refreshing: { scope: number; pending: Promise<Account | null> } | null = null;

function rotate(path: string, body: unknown, bearer?: string): Promise<unknown> {
  if (rotating !== null) rotating.started = true;
  return post(path, body, bearer, { signal: timeoutSignal(30_000) });
}

function currentAccount(scope: number): Account {
  const current = activeAccount();
  if (accountScopeIdentity() !== scope) throw accountChanged();
  if (current === null) throw new Error('Log in first.');
  return current;
}

function serialize<T>(scope: number, run: () => Promise<T>): Promise<T> {
  const pending = serialized.then(() => withAccountLock(() => {
    currentAccount(scope);
    const result = Promise.resolve().then(run);
    const rotation = result.then(() => {
      if (accountScopeIdentity() !== scope && activeAccount() !== null) throw accountChanged();
      return activeAccount();
    });
    rotating = { scope, pending: rotation, started: false };
    return rotation.then(() => result, () => result).finally(() => { rotating = null; });
  }));
  serialized = pending.then(() => undefined, () => undefined);
  return pending;
}

async function refreshCurrent(scope: number): Promise<Account | null> {
  const current = currentAccount(scope);
  try {
    const next = accountFrom(await rotate('/refresh', { refreshToken: current.refreshToken }));
    if (!sameSource(next, current)) throw unexpected();
    storeAccount(next, scope);
    return next;
  } catch (err) {
    if (accountScopeIdentity() !== scope) throw accountChanged();
    if (err instanceof AuthUnavailableError) throw err;
    if (err instanceof AuthResponseError && err.status !== 401) throw new AuthUnavailableError(err.message);
    clearAccount();
    return null;
  }
}

export function refreshAccount(): Promise<Account | null> {
  if (activeAccount() === null) return Promise.resolve(null);
  const scope = accountScopeIdentity();
  if (refreshing?.scope === scope) return refreshing.pending;
  if (rotating?.scope === scope && rotating.started) return rotating.pending;
  const pending = serialize(scope, () => refreshCurrent(scope)).finally(() => {
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
  if (accountScopeIdentity() !== scope && (next !== null || activeAccount() !== null)) throw accountChanged();
  return next !== null && !tokenExpiring(next.accessToken) ? next.accessToken : null;
}

async function freshAccount(scope: number): Promise<Account> {
  let current = currentAccount(scope);
  if (tokenExpiring(current.accessToken)) {
    if (await refreshCurrent(scope) === null) throw new Error('Could not refresh your session. Sign in again.');
    current = currentAccount(scope);
  }
  if (!tokenMatchesAccount(current) || tokenExpiring(current.accessToken)) throw new Error('Your access token has expired. Sign in again.');
  return current;
}

function selectOrganization(path: string, body: Record<string, string>, organization?: string): Promise<Account> {
  const scope = accountScopeIdentity();
  return serialize(scope, async () => {
    const current = await freshAccount(scope);
    currentAccount(scope);
    const next = accountFrom(await rotate(path, { ...body, refreshToken: current.refreshToken }, current.accessToken));
    currentAccount(scope);
    if (!tokenMatchesAccount(next) || next.user.id !== current.user.id || (organization !== undefined && next.organization !== organization)) throw unexpected();
    storeAccount(next, next.organization === current.organization ? scope : undefined);
    return next;
  });
}

export const createOrganization = (name: string): Promise<Account> => selectOrganization('/organization', { name });

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
  agents: OrgAgent[] | null;
}

const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

function agentsOf(value: unknown): OrgAgent[] | null {
  if (!Array.isArray(value)) return null;
  return value.flatMap((a: unknown) =>
    isRecord(a) && typeof a.id === 'string' && typeof a.host === 'string'
      ? [{ id: a.id, host: a.host, name: text(a.name), slug: text(a.slug), avatar: typeof a.avatar === 'string' && a.avatar.startsWith('data:image/png;base64,') ? a.avatar : null }]
      : [],
  );
}

export async function fetchOrganizations(): Promise<OrganizationRow[]> {
  const scope = accountScopeIdentity();
  const bearer = await accessToken();
  currentAccount(scope);
  if (bearer === null) throw new Error('Log in first.');
  const res = await fetch(authUrl('/organizations'), { headers: { authorization: `Bearer ${bearer}` } });
  const body: unknown = await res.json().catch(() => null);
  currentAccount(scope);
  if (!res.ok) throw new Error(errorText(body, res.status));
  return toOrganizations(body);
}

export function toOrganizations(body: unknown): OrganizationRow[] {
  if (!isRecord(body) || !Array.isArray(body.organizations)) throw unexpected();
  return body.organizations.flatMap((o: unknown) =>
    isRecord(o) && typeof o.id === 'string'
      ? [{ id: o.id, name: typeof o.name === 'string' ? o.name : null, role: typeof o.role === 'string' ? o.role : null, slug: typeof o.slug === 'string' ? o.slug : null, agents: agentsOf(o.agents) }]
      : [],
  );
}

export const switchOrganization = (organization: string): Promise<Account> => selectOrganization('/switch', { organization }, organization);

function scopedSwitch(organization: string, refreshToken: string, bearer: string): Promise<unknown> {
  return rotate('/switch', { organization, refreshToken }, bearer);
}

const sameSource = (next: Account, current: Account): boolean => tokenMatchesAccount(next) && next.user.id === current.user.id && next.organization === current.organization;
const rotationRefused = (err: unknown): boolean => err instanceof AuthResponseError && (err.status === 403 || err.status === 404);

async function restoredDestination(scope: number, current: Account, organization: string): Promise<unknown> {
  if (current.organization === null) throw new Error('Select a source organization first.');
  let destination: unknown;
  let restored: Account;
  let switched = false;
  try {
    destination = await scopedSwitch(organization, current.refreshToken, current.accessToken);
    switched = true;
    const refreshToken = isRecord(destination) ? text(destination.refreshToken) : null;
    if (refreshToken === null) throw unexpected();
    restored = accountFrom(await scopedSwitch(current.organization, refreshToken, current.accessToken));
    if (!sameSource(restored, current)) throw unexpected();
  } catch (err) {
    if (!switched && rotationRefused(err)) throw err;
    if (accountScopeIdentity() === scope) clearAccount();
    throw sourceLost();
  }
  storeAccount(restored, scope);
  return destination;
}

async function organizationAccount(scope: number, organization: string, admin: boolean, check?: () => void): Promise<unknown> {
  check?.();
  const current = await freshAccount(scope);
  check?.();
  currentAccount(scope);
  if (admin && current.role !== 'admin') throw new Error('You must be an admin of the source organization.');
  return current.organization === organization ? current : restoredDestination(scope, current, organization);
}

function organizationToken(scope: number, organization: string, admin: boolean, check?: () => void): Promise<string> {
  return serialize(scope, () => organizationAccount(scope, organization, admin, check)).then((body) => {
    const current = currentAccount(scope);
    const next = accountFrom(body);
    if (!tokenMatchesAccount(next) || next.user.id !== current.user.id || next.organization !== organization) throw unexpected();
    if (admin && next.role !== 'admin') throw new Error('You must be an admin of the destination organization.');
    if (tokenExpiring(next.accessToken)) throw new Error('The organization access token has expired. Try again.');
    return next.accessToken;
  });
}

export const organizationAccessToken = (organization: string): Promise<string> => organizationToken(accountScopeIdentity(), organization, true);

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
  const scope = accountScopeIdentity();
  currentAccount(scope);
  const key = `${String(scope)}:${organization}`;
  let flight = scopedTokens.get(key);
  if (flight === undefined) {
    const signals: (AbortSignal | undefined)[] = [];
    const pending = organizationToken(scope, organization, false, () => {
      if (signals.every((signal) => signal?.aborted)) throw cancelled();
    }).finally(() => { scopedTokens.delete(key); });
    flight = { pending, signals };
    scopedTokens.set(key, flight);
  }
  flight.signals.push(options.signal);
  const token = await subscribedToken(flight.pending, options.signal);
  checkCancelled(options.signal);
  currentAccount(scope);
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
