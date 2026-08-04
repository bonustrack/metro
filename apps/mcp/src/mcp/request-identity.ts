import { AsyncLocalStorage } from 'node:async_hooks';
import type { IncomingMessage } from 'node:http';
import { verifySession } from '../daemon/session.js';
import { agentIdForKey } from '../db/key-map.js';

export type RequestIdentity =
  | { kind: 'agent'; agentId: number }
  | { kind: 'google'; email: string; agentIds: number[] };

const storage = new AsyncLocalStorage<RequestIdentity>();

export function runWithIdentity<T>(
  identity: RequestIdentity,
  fn: () => Promise<T>,
): Promise<T> {
  return storage.run(identity, fn);
}

export function currentIdentity(): RequestIdentity | undefined {
  return storage.getStore();
}

export interface AuthConfig {
  sessionSecret: string;
}

export function authConfigFromEnv(): AuthConfig {
  return { sessionSecret: process.env.METRO_SESSION_SECRET?.trim() ?? '' };
}

export function extractToken(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    const t = header.slice(7).trim();
    if (t) return t;
  }
  const qt = new URL(req.url ?? '/', 'http://localhost').searchParams.get(
    'token',
  );
  return qt ?? undefined;
}

const looksLikeJwt = (token: string): boolean =>
  /^[\w-]+\.[\w-]+\.[\w-]+$/.test(token);

export function authenticate(
  req: IncomingMessage,
  cfg: AuthConfig,
): RequestIdentity | null {
  const token = extractToken(req);
  if (!token) return null;

  const agentId = agentIdForKey(token);
  if (agentId !== undefined) return { kind: 'agent', agentId };

  if (cfg.sessionSecret !== '' && looksLikeJwt(token)) {
    try {
      const { email, agentIds } = verifySession(token, cfg.sessionSecret);
      return { kind: 'google', email, agentIds };
    } catch {
      return null;
    }
  }
  return null;
}

export function allowedAgents(
  identity: RequestIdentity | undefined,
): Set<number> {
  if (identity?.kind === 'google') return new Set(identity.agentIds);
  if (identity?.kind === 'agent') return new Set([identity.agentId]);
  return new Set();
}
