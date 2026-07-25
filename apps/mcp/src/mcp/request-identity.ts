import { AsyncLocalStorage } from 'node:async_hooks';
import type { IncomingMessage } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import {
  agentsForEmail,
  parseEmailAgentMap,
  verifyGoogleIdToken,
  type EmailAgentMap,
} from '../daemon/google-auth.js';

export type RequestIdentity =
  | { kind: 'key' }
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
  googleClientId: string;
  emailAgents: EmailAgentMap;
  verifyToken?: (token: string, clientId: string) => Promise<{ email: string }>;
}

export function authConfigFromEnv(): AuthConfig {
  return {
    apiKey: process.env.METRO_MCP_HTTP_TOKEN ?? '',
    googleClientId: process.env.GOOGLE_OAUTH_CLIENT_ID?.trim() ?? '',
    emailAgents: parseEmailAgentMap(process.env.GOOGLE_EMAIL_AGENTS),
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

export async function authenticate(
  req: IncomingMessage,
  cfg: AuthConfig,
): Promise<RequestIdentity | null> {
  if (cfg.apiKey === '' && cfg.googleClientId === '') return { kind: 'key' };

  const token = extractToken(req);
  if (!token) return null;

  if (keyEquals(token, cfg.apiKey)) return { kind: 'key' };

  if (cfg.googleClientId !== '' && looksLikeJwt(token)) {
    const verify =
      cfg.verifyToken ??
      ((t, clientId) => verifyGoogleIdToken(t, { clientId }));
    try {
      const { email } = await verify(token, cfg.googleClientId);
      const agents = agentsForEmail(cfg.emailAgents, email);
      if (!agents) return null;
      return { kind: 'google', email: email.toLowerCase(), agents };
    } catch {
      return null;
    }
  }
  return null;
}
