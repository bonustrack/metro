import { AsyncLocalStorage } from 'node:async_hooks';
import type { IncomingMessage } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { verifySession } from '../daemon/session.js';
import { agentForKey } from '../db/key-map.js';

export type RequestIdentity =
  | { kind: 'key' }
  | { kind: 'agent'; agent: string }
  | { kind: 'google'; email: string; agents: string[] };

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

  const agent = agentForKey(token);
  if (agent !== undefined) return { kind: 'agent', agent };

  if (cfg.sessionSecret !== '' && looksLikeJwt(token)) {
    try {
      const { email, agents } = verifySession(token, cfg.sessionSecret);
      return { kind: 'google', email, agents };
    } catch {
      return null;
    }
  }
  return null;
}

export function allowedAgents(
  identity: RequestIdentity | undefined,
): Set<string> | undefined {
  if (identity?.kind === 'google') return new Set(identity.agents);
  if (identity?.kind === 'agent') return new Set([identity.agent]);
  return undefined;
}
