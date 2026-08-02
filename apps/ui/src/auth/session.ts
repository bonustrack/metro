const STORAGE_KEY = 'metro.session';
const DEFAULT_DAEMON = 'https://mcp.metro.box';
const EXP_SKEW_MS = 60_000;

export function daemonBase(): string {
  const configured = import.meta.env.VITE_METRO_MCP_URL?.trim();
  const base = configured !== undefined && configured !== '' ? configured : DEFAULT_DAEMON;
  try {
    return new URL(base, window.location.origin).origin;
  } catch {
    return DEFAULT_DAEMON;
  }
}

export function startLoginUrl(): string {
  const returnTo = window.location.origin + window.location.pathname;
  return `${daemonBase()}/auth/google/start?return_to=${encodeURIComponent(returnTo)}`;
}

export function storedSession(): string | null {
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    return v !== null && v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

export function storeSession(token: string): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, token);
  } catch {
    return;
  }
}

export function clearSession(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    return;
  }
}

export interface SessionClaims {
  email: string;
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
  return { email: sub, expiresAt: exp * 1000 };
}

export function sessionIsFresh(token: string, now = Date.now()): boolean {
  const claims = sessionClaims(token);
  return claims !== null && claims.expiresAt - EXP_SKEW_MS > now;
}

export interface FragmentResult {
  session?: string;
  error?: string;
}

export function consumeFragment(): FragmentResult {
  const hash = window.location.hash.replace(/^#/, '');
  if (hash === '') return {};
  const params = new URLSearchParams(hash);
  const session = params.get('session');
  const error = params.get('error');
  if (session !== null || error !== null) {
    const clean = window.location.pathname + window.location.search;
    window.history.replaceState(null, '', clean);
  }
  return {
    session: session ?? undefined,
    error: error ?? undefined,
  };
}
