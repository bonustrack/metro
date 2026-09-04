import type { ConnectorAuth, OAuthAuth } from '../daemon/connector-verify.js';

export type RelayTarget =
  | { kind: 'ok'; url: string; headers: Record<string, string> }
  | { kind: 'missing' }
  | { kind: 'signin' };

export const bearerHeaders = (token: string): Record<string, string> => ({
  Authorization: `Bearer ${token}`,
});

export function staleUsable(auth: OAuthAuth, now = Date.now()): boolean {
  return auth.expiresAt === undefined || auth.expiresAt > now;
}

function headerAuthHeaders(auth: ConnectorAuth): Record<string, string> | null {
  return auth.kind === 'header' ? { [auth.name]: auth.value } : null;
}

export function unrefreshedTarget(
  url: string,
  auth: OAuthAuth,
  force: boolean,
  now = Date.now(),
): RelayTarget {
  if (force) return { kind: 'signin' };
  if (staleUsable(auth, now))
    return { kind: 'ok', url, headers: bearerHeaders(auth.accessToken) };
  return { kind: 'ok', url, headers: {} };
}

export function fixedTarget(
  url: string,
  auth: Exclude<ConnectorAuth, OAuthAuth>,
  force: boolean,
): RelayTarget {
  if (force) return { kind: 'signin' };
  return { kind: 'ok', url, headers: headerAuthHeaders(auth) ?? {} };
}
