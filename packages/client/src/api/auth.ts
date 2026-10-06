import { builtInDaemon } from '../auth/daemon.js';
import { signInReturnUrl, timeoutSignal } from '../platform.js';
import { accountFrom, activeAccount, clearAccount, isCurrentAccount, storeAccount, tokenExpiring, type Account } from '../auth/account.js';
import { isRecord } from '../read.js';
import { clearInvitation, pendingInvitation } from '../auth/invitation.js';

export type Provider = 'google' | 'microsoft' | 'github';
export const PROVIDERS: Provider[] = ['google', 'microsoft', 'github'];

const authUrl = (path: string): string => `${builtInDaemon()}/api/auth${path}`;
const unexpected = (): Error => new Error('Metro returned an unexpected response.');

function errorText(body: unknown, status: number): string {
  return isRecord(body) && typeof body.error === 'string' ? body.error : `Metro returned ${String(status)}.`;
}

async function post(path: string, body: unknown, bearer?: string, controls?: Pick<RequestInit, 'redirect' | 'signal'>): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(authUrl(path), {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(bearer === undefined ? {} : { authorization: `Bearer ${bearer}` }) },
      body: JSON.stringify(body),
      ...controls,
    });
  } catch {
    throw new Error('Failed to reach Metro.');
  }
  const answer: unknown = await res.json().catch(() => null);
  if (!res.ok) throw new Error(errorText(answer, res.status));
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
  const account = accountFrom(await post('/exchange', verifier === undefined ? { code } : { code, verifier }));
  storeAccount(account);
  clearInvitation();
  return account;
}

let refreshing: Promise<Account | null> | null = null;

export function refreshAccount(): Promise<Account | null> {
  const current = activeAccount();
  if (current === null) return Promise.resolve(null);
  refreshing ??= post('/refresh', { refreshToken: current.refreshToken })
    .then((body) => {
      if (!isCurrentAccount(current)) return null;
      const next = accountFrom(body);
      storeAccount(next);
      return next;
    })
    .catch((err: unknown) => {
      if (isCurrentAccount(current) && err instanceof Error && err.message !== 'Failed to reach Metro.') clearAccount();
      return null;
    })
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}

export async function accessToken(): Promise<string | null> {
  const current = activeAccount();
  if (current === null) return null;
  if (!tokenExpiring(current.accessToken)) return current.accessToken;
  return (await refreshAccount())?.accessToken ?? null;
}

export async function createOrganization(name: string): Promise<Account> {
  const current = activeAccount();
  if (current === null) throw new Error('Sign in first.');
  const bearer = (await accessToken()) ?? current.accessToken;
  const next = accountFrom(await post('/organization', { name, refreshToken: activeAccount()?.refreshToken ?? current.refreshToken }, bearer));
  storeAccount(next);
  return next;
}

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
  const bearer = await accessToken();
  if (bearer === null) throw new Error('Log in first.');
  const res = await fetch(authUrl('/organizations'), { headers: { authorization: `Bearer ${bearer}` } });
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) throw new Error(errorText(body, res.status));
  if (!isRecord(body) || !Array.isArray(body.organizations)) throw unexpected();
  return body.organizations.flatMap((o: unknown) =>
    isRecord(o) && typeof o.id === 'string'
      ? [{ id: o.id, name: typeof o.name === 'string' ? o.name : null, role: typeof o.role === 'string' ? o.role : null, slug: typeof o.slug === 'string' ? o.slug : null, agents: agentsOf(o.agents) }]
      : [],
  );
}

export async function switchOrganization(organization: string): Promise<Account> {
  const current = activeAccount();
  if (current === null) throw new Error('Log in first.');
  const bearer = (await accessToken()) ?? current.accessToken;
  const next = accountFrom(await post('/switch', { organization, refreshToken: activeAccount()?.refreshToken ?? current.refreshToken }, bearer));
  storeAccount(next);
  return next;
}

function copySwitch(organization: string | null, refreshToken: string, bearer: string): Promise<unknown> {
  return post('/switch', { organization, refreshToken }, bearer, { redirect: 'manual', signal: timeoutSignal(30_000) });
}

async function waitForRefresh(): Promise<void> {
  while (refreshing !== null) await refreshing;
}

async function restoreCopyAccount(current: Account, bearer: string, destination: Account): Promise<Account> {
  const unchanged = (): boolean => activeAccount()?.refreshToken === current.refreshToken;
  if (destination.user.id !== current.user.id || !unchanged()) throw new Error('Your account changed, try again.');
  try {
    const restored = accountFrom(await copySwitch(current.organization, destination.refreshToken, bearer));
    if (restored.user.id !== current.user.id || restored.organization !== current.organization || !unchanged()) throw unexpected();
    storeAccount(restored);
    return restored;
  } catch {
    if (unchanged()) clearAccount();
    throw new Error('Could not restore your source session. Sign in again before copying.');
  }
}

async function copyOrganizationToken(organization: string): Promise<string> {
  await waitForRefresh();
  const bearer = await accessToken();
  await waitForRefresh();
  const current = activeAccount();
  if (current === null || bearer === null) throw new Error('Log in first.');
  if (current.organization === organization) return current.accessToken;
  const switching = copySwitch(organization, current.refreshToken, current.accessToken).then(accountFrom);
  refreshing = switching.then((next) => restoreCopyAccount(current, current.accessToken, next)).catch(() => {
    if (activeAccount()?.refreshToken === current.refreshToken) clearAccount();
    throw new Error('Could not prepare your copy session. Sign in again before copying.');
  }).finally(() => { refreshing = null; });
  await refreshing;
  const next = await switching;
  if (next.organization !== organization || next.role !== 'admin') throw new Error('You must be an admin of the destination organization.');
  return next.accessToken;
}

let copying: Promise<void> = Promise.resolve();

export function organizationAccessToken(organization: string): Promise<string> {
  const pending = copying.then(() => copyOrganizationToken(organization));
  copying = pending.then(() => undefined, () => undefined);
  return pending;
}

export async function updateAccount(changes: { name?: string; avatar?: string | null }): Promise<Account | null> {
  const current = activeAccount();
  if (current === null) throw new Error('Log in first.');
  const bearer = (await accessToken()) ?? current.accessToken;
  let res: Response;
  try {
    res = await fetch(authUrl('/account'), { method: 'PUT', headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` }, body: JSON.stringify(changes) });
  } catch {
    throw new Error('Failed to reach Metro.');
  }
  const answer: unknown = await res.json().catch(() => null);
  if (!res.ok) throw new Error(errorText(answer, res.status));
  return refreshAccount();
}

export async function logoutAccount(): Promise<void> {
  const current = activeAccount();
  clearAccount();
  if (current === null) return;
  await post('/logout', {}, current.accessToken).catch(() => undefined);
}
