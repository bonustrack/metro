import { builtInDaemon } from '../auth/daemon.js';
import { accountFrom, activeAccount, clearAccount, storeAccount, tokenExpiring, type Account } from '../auth/account.js';
import { isRecord } from './accounts.js';

export type Provider = 'google' | 'microsoft' | 'github';
const PROVIDER_NAMES: string[] = ['google', 'microsoft', 'github'];

export interface AuthStatus {
  enabled: boolean;
  providers: Provider[];
}

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

export async function fetchAuthStatus(): Promise<AuthStatus> {
  const res = await fetch(authUrl(''));
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok || !isRecord(body)) throw unexpected();
  const providers = Array.isArray(body.providers) ? body.providers.filter((p): p is Provider => typeof p === 'string' && PROVIDER_NAMES.includes(p)) : [];
  return { enabled: body.enabled === true, providers };
}

export const returnTo = (): string => `${window.location.origin}${window.location.pathname}`;

export const loginUrl = (provider: Provider): string => authUrl(`/login?provider=${provider}&return_to=${encodeURIComponent(returnTo())}`);

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

export interface OrganizationRow {
  id: string;
  name: string | null;
  role: string | null;
}

export async function fetchOrganizations(): Promise<OrganizationRow[]> {
  const bearer = await accessToken();
  if (bearer === null) throw new Error('Log in first.');
  const res = await fetch(authUrl('/organizations'), { headers: { authorization: `Bearer ${bearer}` } });
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) throw new Error(errorText(body, res.status));
  if (!isRecord(body) || !Array.isArray(body.organizations)) throw unexpected();
  return body.organizations.flatMap((o: unknown) =>
    isRecord(o) && typeof o.id === 'string' ? [{ id: o.id, name: typeof o.name === 'string' ? o.name : null, role: typeof o.role === 'string' ? o.role : null }] : [],
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

export async function logoutAccount(): Promise<void> {
  const current = activeAccount();
  clearAccount();
  if (current === null) return;
  await post('/logout', {}, current.accessToken).catch(() => undefined);
}
