import { authHeaders, type ConnectorAuth, type OAuthAuth } from './verify.js';

export type RelayTarget =
  | { kind: 'ok'; url: string; headers: Record<string, string> }
  | { kind: 'missing' }
  | { kind: 'signin' };

function staleUsable(auth: OAuthAuth, now = Date.now()): boolean {
  return auth.expiresAt === undefined || auth.expiresAt > now;
}

export function unrefreshedTarget(
  url: string,
  auth: OAuthAuth,
  force: boolean,
  now = Date.now(),
): RelayTarget {
  if (force) return { kind: 'signin' };
  return { kind: 'ok', url, headers: staleUsable(auth, now) ? authHeaders(auth) : {} };
}

export function fixedTarget(
  url: string,
  auth: Exclude<ConnectorAuth, OAuthAuth>,
  force: boolean,
): RelayTarget {
  if (force) return { kind: 'signin' };
  return { kind: 'ok', url, headers: authHeaders(auth) };
}
