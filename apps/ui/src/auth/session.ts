import { builtInDaemon, storedDaemon } from './daemon';

const STORAGE_KEY = 'metro.session';
const PROJECT_KEY = 'metro.project';
const EXP_SKEW_MS = 60_000;

export function daemonBase(): string {
  return storedDaemon() ?? builtInDaemon();
}

const keyFor = (base: string): string =>
  base === builtInDaemon() ? STORAGE_KEY : `${STORAGE_KEY}:${base}`;

function sessionKey(): string {
  return keyFor(daemonBase());
}

export function sessionFor(base: string): string | null {
  try {
    const v = window.localStorage.getItem(keyFor(base));
    return v !== null && v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

export function storeSessionFor(base: string, token: string): void {
  try {
    window.localStorage.setItem(keyFor(base), token);
  } catch {
    return;
  }
}

export function clearSessionFor(base: string): void {
  try {
    window.localStorage.removeItem(keyFor(base));
  } catch {
    return;
  }
}

export function storedSession(): string | null {
  try {
    const v = window.localStorage.getItem(sessionKey());
    return v !== null && v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

export function storeSession(token: string): void {
  try {
    window.localStorage.setItem(sessionKey(), token);
  } catch {
    return;
  }
}

export function storedProject(): string | null {
  try {
    const v = window.localStorage.getItem(PROJECT_KEY);
    return v !== null && v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

export function storeProject(id: string): void {
  try {
    window.localStorage.setItem(PROJECT_KEY, id);
  } catch {
    return;
  }
}

export function clearSession(): void {
  try {
    window.localStorage.removeItem(sessionKey());
  } catch {
    return;
  }
}

export interface SessionClaims {
  subject: string;
  expiresAt: number;
}

interface RawClaims {
  sub?: unknown;
  exp?: unknown;
}

function decodeClaims(token: string): RawClaims | null {
  const parts = token.split('.');
  const body = parts[1];
  if (parts.length !== 3 || body === undefined) return null;
  try {
    return JSON.parse(atob(body.replace(/-/g, '+').replace(/_/g, '/'))) as RawClaims;
  } catch {
    return null;
  }
}

export function sessionClaims(token: string): SessionClaims | null {
  const raw = decodeClaims(token);
  if (raw === null) return null;
  const { sub, exp } = raw;
  if (typeof sub !== 'string' || typeof exp !== 'number') return null;
  return { subject: sub, expiresAt: exp * 1000 };
}

export function sessionIsFresh(token: string, now = Date.now()): boolean {
  const claims = sessionClaims(token);
  return claims !== null && claims.expiresAt - EXP_SKEW_MS > now;
}
