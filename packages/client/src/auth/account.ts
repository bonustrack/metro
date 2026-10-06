import { filled, isRecord } from '../read.js';
import { randomBytes, readItem, writeItem } from '../platform.js';

const STORAGE_KEY = 'metro.account';
const EXPIRY_MARGIN_MS = 60_000;

interface AccountUser {
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
let scopeIdentity = 0;
let sessionScope: string | null = null;
let signingOut: string | null = null;
let stored: string | null | undefined;
let listening: Window | null = null;
const scopeListeners = new Set<() => void>();

export const activeAccount = (): Account | null => { syncAccount(); return active; };
export const accountScopeIdentity = (): number => { syncAccount(); return scopeIdentity; };
const browser = (): boolean => typeof window !== 'undefined' && typeof window.document === 'object';

function storageChanged(event: StorageEvent): void {
  if (event.key === STORAGE_KEY || event.key === null) syncAccount();
}

function syncAccount(): void {
  if (!browser()) return;
  if (listening !== window) {
    listening?.removeEventListener('storage', storageChanged);
    listening = window;
    listening.addEventListener('storage', storageChanged);
  }
  const raw = readItem(STORAGE_KEY);
  if (raw !== stored) readAccount(raw);
}

export async function withAccountLock<T>(run: () => Promise<T>): Promise<T> {
  if (!browser()) return run();
  if (typeof navigator === 'undefined' || navigator.locks === undefined) throw new Error('This browser cannot safely refresh your session. Use a browser with Web Locks.');
  return await navigator.locks.request(STORAGE_KEY, () => { syncAccount(); return run(); });
}

export function beginAccountLogout(): number {
  syncAccount();
  if (browser()) {
    signingOut = sessionScope;
    active = null;
    changedScope();
  }
  return scopeIdentity;
}

export function subscribeAccountScope(listener: () => void): () => void {
  scopeListeners.add(listener);
  return () => { scopeListeners.delete(listener); };
}

function changedScope(): void {
  scopeIdentity += 1;
  for (const listener of scopeListeners) listener();
}

const HANDOFF_RE = /^#\/auth\/([A-Za-z0-9_-]{16,128})$/;

export const handoffCode = (hash: string): string | null => HANDOFF_RE.exec(hash)?.[1] ?? null;

function tokenClaims(token: string): Record<string, unknown> | null {
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
  return typeof exp === 'number' && Number.isFinite(exp * 1000) ? exp * 1000 : null;
}

export function tokenMatchesAccount(account: Account): boolean {
  const claims = tokenClaims(account.accessToken);
  return claims?.sub === account.user.id && filled(claims.org_id) === account.organization;
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

function savedAccount(): Account | null {
  const raw = readItem(STORAGE_KEY);
  if (raw === null) return null;
  try {
    return accountFrom(JSON.parse(raw));
  } catch {
    return null;
  }
}

export interface AccountIdentity {
  user: string;
  organization: string;
  session: string;
}

function identityOf(account: Account | null): AccountIdentity | null {
  if (account === null || account.organization === null) return null;
  const session = filled(tokenClaims(account.accessToken)?.sid);
  return session === null ? null : { user: account.user.id, organization: account.organization, session };
}

export const accountIdentity = (): AccountIdentity | null => identityOf(activeAccount());

const sameIdentity = (expected: AccountIdentity, current: AccountIdentity | null): boolean =>
  current !== null && current.user === expected.user && current.organization === expected.organization && current.session === expected.session;

export function checkAccountIdentity(expected: AccountIdentity | null): asserts expected is AccountIdentity {
  if (expected === null || !sameIdentity(expected, accountIdentity()) || !sameIdentity(expected, identityOf(savedAccount())))
    throw new Error('The Metro account changed. Start the sign-in again.');
}

function storedScope(body: unknown, account: Account | null): string | null {
  if (account === null) return null;
  if (isRecord(body) && typeof body.sessionScope === 'string') return body.sessionScope;
  return JSON.stringify([account.user.id, account.organization, tokenClaims(account.accessToken)?.sid]);
}

const storedIdentity = (): string => JSON.stringify([sessionScope, active?.user.id, active?.organization]);

function readAccount(raw: string | null): void {
  const previous = storedIdentity();
  stored = raw;
  try {
    const body: unknown = raw === null ? null : JSON.parse(raw);
    active = body === null ? null : accountFrom(body);
    sessionScope = storedScope(body, active);
    if (sessionScope === signingOut) active = null;
  } catch {
    active = null;
    sessionScope = null;
  }
  if (previous !== storedIdentity()) changedScope();
}

export function loadAccount(): Account | null {
  readAccount(readItem(STORAGE_KEY));
  syncAccount();
  return active;
}

export function storeAccount(account: Account, scope?: number): void {
  syncAccount();
  if (scope !== undefined && (scope !== scopeIdentity || active?.user.id !== account.user.id || active.organization !== account.organization)) throw new Error('Your account changed, try again.');
  active = account;
  if (scope === undefined) {
    signingOut = null;
    sessionScope = Array.from(randomBytes(16), (byte) => byte.toString(16).padStart(2, '0')).join('');
  }
  writeItem(STORAGE_KEY, JSON.stringify({ ...account, sessionScope }));
  stored = readItem(STORAGE_KEY);
  if (scope === undefined) changedScope();
}

export function clearAccount(): void {
  active = null;
  sessionScope = null;
  signingOut = null;
  writeItem(STORAGE_KEY, null);
  stored = readItem(STORAGE_KEY);
  changedScope();
}
