import { filled, isRecord } from '../api/read.js';

const STORAGE_KEY = 'metro.account';
const EXPIRY_MARGIN_MS = 60_000;

export interface AccountUser {
  id: string;
  email: string | null;
  name: string | null;
  picture: string | null;
}

export interface Account {
  accessToken: string;
  refreshToken: string;
  organization: string | null;
  organizationName: string | null;
  organizationSlug: string | null;
  role: string | null;
  user: AccountUser;
}

let active: Account | null = null;

export const activeAccount = (): Account | null => active;

const HANDOFF_RE = /^#\/auth\/([A-Za-z0-9_-]{16,128})$/;

export const handoffCode = (hash: string): string | null => HANDOFF_RE.exec(hash)?.[1] ?? null;

export function tokenClaims(token: string): Record<string, unknown> | null {
  const body = token.split('.')[1];
  if (body === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(atob(body.replace(/-/g, '+').replace(/_/g, '/')));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function tokenExpiry(token: string): number | null {
  const exp = tokenClaims(token)?.exp;
  return typeof exp === 'number' ? exp * 1000 : null;
}

export const tokenExpiring = (token: string, now = Date.now()): boolean => {
  const exp = tokenExpiry(token);
  return exp === null || exp - now < EXPIRY_MARGIN_MS;
};

export function accountFrom(body: unknown): Account {
  if (!isRecord(body) || !isRecord(body.user)) throw new Error('Metro returned an unexpected response.');
  const accessToken = filled(body.accessToken);
  const refreshToken = filled(body.refreshToken);
  const id = filled(body.user.id);
  if (accessToken === null || refreshToken === null || id === null) throw new Error('Metro returned an unexpected response.');
  const claims = tokenClaims(accessToken) ?? {};
  return {
    accessToken,
    refreshToken,
    organization: filled(body.organization) ?? filled(claims.org_id),
    organizationName: filled(body.organizationName),
    organizationSlug: filled(body.organizationSlug),
    role: filled(claims.role),
    user: { id, email: filled(body.user.email), name: filled(body.user.name), picture: filled(body.user.picture) },
  };
}

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function loadAccount(): Account | null {
  const raw = storage()?.getItem(STORAGE_KEY) ?? null;
  if (raw === null) return (active = null);
  try {
    active = accountFrom(JSON.parse(raw));
  } catch {
    active = null;
  }
  return active;
}

export function storeAccount(account: Account): void {
  active = account;
  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify(account));
  } catch {
    return;
  }
}

export function clearAccount(): void {
  active = null;
  try {
    storage()?.removeItem(STORAGE_KEY);
  } catch {
    return;
  }
}
