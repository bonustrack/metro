import { filled, isRecord } from '../read.js';
import { randomBytes, readItem, readTabItem, writeItem, writeTabItem } from '../platform.js';

const STORAGE_KEY = 'metro.account';
const TAB_KEY = 'metro.account.tab';
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

interface Entry {
  organization: string;
  accessToken: string;
  organizationName: string | null;
  organizationSlug: string | null;
}

export class AccountChangedError extends Error {
  constructor() {
    super('Your account changed, try again.');
  }
}

let shared: Account | null = null;
let active: Account | null = null;
let selected: { scope: string; organization: string } | null = null;
const tokens = new Map<string, Entry>();
let tokensScope: string | null = null;
let scopeIdentity = 0;
let sessionIdentity = 0;
let sessionScope: string | null = null;
let signingOut: string | null = null;
let stored: string | null | undefined;
let tabWritten: string | null = null;
let listening: Window | null = null;
const scopeListeners = new Set<() => void>();

export const activeAccount = (): Account | null => { syncAccount(); return active; };
export const accountScopeIdentity = (): number => { syncAccount(); return scopeIdentity; };
export const accountSessionIdentity = (): number => { syncAccount(); return sessionIdentity; };
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
    const before = identities();
    signingOut = sessionScope;
    active = null;
    if (before[1] !== sessionKey()) sessionIdentity += 1;
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

const claimsMatch = (token: string, user: string, organization: string | null): boolean => {
  const claims = tokenClaims(token);
  return claims?.sub === user && filled(claims.org_id) === organization;
};

export const tokenMatchesAccount = (account: Account): boolean => claimsMatch(account.accessToken, account.user.id, account.organization);

export const tokenExpiring = (token: string, now = Date.now()): boolean => {
  const exp = tokenExpiry(token);
  return exp === null || exp - now < EXPIRY_MARGIN_MS;
};

const later = (token: string, than: string): boolean => (tokenExpiry(token) ?? 0) > (tokenExpiry(than) ?? 0);

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

const savedOrganization = (body: unknown, saved: Account): string | null =>
  active !== null && storedScope(body, saved) === sessionScope && active.user.id === saved.user.id ? active.organization : saved.organization;

function savedIdentity(): AccountIdentity | null {
  const raw = readItem(STORAGE_KEY);
  if (raw === null) return null;
  try {
    const body: unknown = JSON.parse(raw);
    const saved = accountFrom(body);
    return identityOf({ ...saved, organization: savedOrganization(body, saved) });
  } catch {
    return null;
  }
}

export function checkAccountIdentity(expected: AccountIdentity | null): asserts expected is AccountIdentity {
  if (expected === null || !sameIdentity(expected, accountIdentity()) || !sameIdentity(expected, savedIdentity()))
    throw new Error('The Metro account changed. Start the sign-in again.');
}

function storedScope(body: unknown, account: Account | null): string | null {
  if (account === null) return null;
  if (isRecord(body) && typeof body.sessionScope === 'string') return body.sessionScope;
  return JSON.stringify([account.user.id, account.organization, tokenClaims(account.accessToken)?.sid]);
}

const identityKey = (): string => JSON.stringify([sessionScope, active?.user.id, active?.organization]);
const sessionKey = (): string => JSON.stringify([sessionScope, active?.user.id]);
const identities = (): [string, string] => [identityKey(), sessionKey()];

const entryOf = (account: Account): Entry | null =>
  account.organization === null ? null : { organization: account.organization, accessToken: account.accessToken, organizationName: account.organizationName, organizationSlug: account.organizationSlug };

function remember(entry: Entry | null, newest: boolean): void {
  if (entry === null || shared === null || sessionScope === null || !claimsMatch(entry.accessToken, shared.user.id, entry.organization)) return;
  if (tokensScope !== sessionScope) {
    tokens.clear();
    tokensScope = sessionScope;
  }
  const known = tokens.get(entry.organization);
  if (newest || known === undefined || later(entry.accessToken, known.accessToken)) tokens.set(entry.organization, entry);
}

function withEntry(session: Account, organization: string, entry: Entry | undefined): Account {
  const accessToken = entry?.accessToken ?? '';
  return { ...session, accessToken, organization, organizationName: entry?.organizationName ?? null, organizationSlug: entry?.organizationSlug ?? null, role: filled(tokenClaims(accessToken)?.role) };
}

function viewOf(organization: string | null): Account | null {
  if (shared === null || organization === null) return shared;
  const entry = tokensScope === sessionScope ? tokens.get(organization) : undefined;
  const newer = entry !== undefined && later(entry.accessToken, shared.accessToken);
  return organization === shared.organization && !newer ? shared : withEntry(shared, organization, entry);
}

function readTab(): Entry | null {
  const raw = readTabItem(TAB_KEY);
  if (raw === null || sessionScope === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value) || value.scope !== sessionScope) return null;
    const organization = filled(value.organization);
    if (organization === null) return null;
    return { organization, accessToken: filled(value.accessToken) ?? '', organizationName: filled(value.organizationName), organizationSlug: filled(value.organizationSlug) };
  } catch {
    return null;
  }
}

function writeTab(entry: Entry | null): void {
  const value = entry === null || sessionScope === null ? null : JSON.stringify({ scope: sessionScope, ...entry });
  if (value === tabWritten) return;
  tabWritten = value;
  writeTabItem(TAB_KEY, value);
}

function tabOrganization(): string | null {
  if (sessionScope === null) return null;
  if (selected?.scope === sessionScope) return selected.organization;
  const tab = readTab();
  if (tab === null) return shared?.organization ?? null;
  remember(tab, false);
  return tab.organization;
}

function settle(before: [string, string], organization: string | null): void {
  active = sessionScope !== null && sessionScope === signingOut ? null : viewOf(organization);
  const entry = active === null ? null : entryOf(active);
  if (entry !== null && sessionScope !== null) selected = { scope: sessionScope, organization: entry.organization };
  if (entry !== null || active === null) writeTab(entry);
  if (before[1] !== sessionKey()) sessionIdentity += 1;
  if (before[0] !== identityKey()) changedScope();
}

function readAccount(raw: string | null): void {
  const before = identities();
  stored = raw;
  try {
    const body: unknown = raw === null ? null : JSON.parse(raw);
    shared = body === null ? null : accountFrom(body);
    sessionScope = storedScope(body, shared);
  } catch {
    shared = null;
    sessionScope = null;
  }
  if (shared !== null) remember(entryOf(shared), false);
  settle(before, tabOrganization());
}

export function loadAccount(): Account | null {
  readAccount(readItem(STORAGE_KEY));
  syncAccount();
  return active;
}

function persist(): void {
  writeItem(STORAGE_KEY, shared === null ? null : JSON.stringify({ ...shared, sessionScope }));
  stored = readItem(STORAGE_KEY);
}

function save(account: Account, shown: boolean): void {
  shared = shown || shared === null ? account : { ...shared, refreshToken: account.refreshToken, user: account.user };
  remember(entryOf(account), true);
  persist();
}

const refused = (scope: number, account: Account): boolean => scope !== scopeIdentity || active === null || active.user.id !== account.user.id;

export function storeAccount(account: Account, scope?: number): void {
  syncAccount();
  const before = identities();
  if (scope === undefined) {
    signingOut = null;
    selected = null;
    sessionScope = Array.from(randomBytes(16), (byte) => byte.toString(16).padStart(2, '0')).join('');
  } else if (refused(scope, account) || active?.organization !== account.organization) throw new AccountChangedError();
  save(account, true);
  settle(before, account.organization);
}

export function selectAccount(account: Account, scope: number): void {
  syncAccount();
  if (refused(scope, account) || account.organization === null) throw new AccountChangedError();
  const before = identities();
  save(account, true);
  settle(before, account.organization);
}

export function keepOrganizationAccount(account: Account, scope: number): void {
  syncAccount();
  if (refused(scope, account) || account.organization === null) throw new AccountChangedError();
  const before = identities();
  const organization = active?.organization ?? null;
  save(account, account.organization === shared?.organization);
  settle(before, organization);
}

export function keepRefreshToken(refreshToken: string, scope: number): void {
  syncAccount();
  if (scope !== scopeIdentity || active === null || shared === null) throw new AccountChangedError();
  const before = identities();
  shared = { ...shared, refreshToken };
  persist();
  settle(before, active.organization);
}

export function organizationAccount(organization: string): Account | null {
  syncAccount();
  if (active === null) return null;
  const account = viewOf(organization);
  return account !== null && tokenMatchesAccount(account) && !tokenExpiring(account.accessToken) ? account : null;
}

export function forgetOrganizationAccount(organization: string): void {
  syncAccount();
  if (active?.organization !== organization) tokens.delete(organization);
}

export function shareActiveAccount(): Promise<void> {
  return withAccountLock(() => {
    if (active !== null && shared !== null && active.organization !== shared.organization && tokenMatchesAccount(active)) {
      shared = active;
      persist();
    }
    return Promise.resolve();
  });
}

export function clearAccount(): void {
  const before = identities();
  shared = null;
  active = null;
  sessionScope = null;
  signingOut = null;
  selected = null;
  tokens.clear();
  tokensScope = null;
  writeItem(STORAGE_KEY, null);
  stored = readItem(STORAGE_KEY);
  writeTab(null);
  if (before[1] !== sessionKey()) sessionIdentity += 1;
  changedScope();
}
