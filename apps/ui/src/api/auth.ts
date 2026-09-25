import { builtInDaemon } from '../auth/daemon.js';
import { accountFrom, activeAccount, clearAccount, storeAccount, tokenExpiring, type Account } from '../auth/account.js';
import { isRecord } from './read.js';

export type Provider = 'google' | 'microsoft' | 'github';
export const PROVIDERS: Provider[] = ['google', 'microsoft', 'github'];

const authUrl = (path: string): string => `${builtInDaemon()}/api/auth${path}`;
const unexpected = (): Error => new Error('Metro returned an unexpected response.');

function errorText(body: unknown, status: number): string {
  return isRecord(body) && typeof body.error === 'string' ? body.error : `Metro returned ${String(status)}.`;
}

async function post(path: string, body: unknown, bearer?: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(authUrl(path), {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(bearer === undefined ? {} : { authorization: `Bearer ${bearer}` }) },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error('Failed to reach Metro.');
  }
  const answer: unknown = await res.json().catch(() => null);
  if (!res.ok) throw new Error(errorText(answer, res.status));
  return answer;
}

export const returnTo = (): string => `${window.location.origin}${window.location.pathname}`;

export type Intent = 'login' | 'waitlist';

export const loginUrl = (provider: Provider, intent: Intent): string =>
  authUrl(`/login?provider=${provider}&return_to=${encodeURIComponent(returnTo())}${intent === 'waitlist' ? '&intent=waitlist' : ''}`);

export async function exchangeHandoff(code: string): Promise<Account> {
  const account = accountFrom(await post('/exchange', { code }));
  storeAccount(account);
  return account;
}

let refreshing: Promise<Account | null> | null = null;

export function refreshAccount(): Promise<Account | null> {
  const current = activeAccount();
  if (current === null) return Promise.resolve(null);
  refreshing ??= post('/refresh', { refreshToken: current.refreshToken })
    .then((body) => {
      const next = accountFrom(body);
      storeAccount(next);
      return next;
    })
    .catch((err: unknown) => {
      if (err instanceof Error && err.message !== 'Failed to reach Metro.') clearAccount();
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
