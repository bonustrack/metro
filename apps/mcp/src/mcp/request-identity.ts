import { AsyncLocalStorage } from 'node:async_hooks';
import type { IncomingMessage } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { verifySession } from '../daemon/session.js';
import { agentIdForKey } from '../db/key-map.js';

export type RequestIdentity =
  | { kind: 'key' }
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
  apiKey: string;
  sessionSecret: string;
}

export function authConfigFromEnv(): AuthConfig {
  return {
    apiKey: process.env.METRO_MCP_HTTP_TOKEN ?? '',
    sessionSecret: process.env.METRO_SESSION_SECRET?.trim() ?? '',
  };
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

function keyEquals(given: string, want: string): boolean {
  if (want === '') return false;
  const g = Buffer.from(given);
  const w = Buffer.from(want);
  return g.length === w.length && timingSafeEqual(g, w);
}

const looksLikeJwt = (token: string): boolean =>
  /^[\w-]+\.[\w-]+\.[\w-]+$/.test(token);

export function authenticate(
  req: IncomingMessage,
  cfg: AuthConfig,
): RequestIdentity | null {
  if (cfg.apiKey === '' && cfg.sessionSecret === '') return { kind: 'key' };

  const token = extractToken(req);
  if (!token) return null;

  if (keyEquals(token, cfg.apiKey)) return { kind: 'key' };

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
): Set<number> | undefined {
  if (identity?.kind === 'google') return new Set(identity.agentIds);
  if (identity?.kind === 'agent') return new Set([identity.agentId]);
  return undefined;
}
