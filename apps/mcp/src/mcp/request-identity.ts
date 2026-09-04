import { AsyncLocalStorage } from 'node:async_hooks';
import type { IncomingMessage } from 'node:http';
import { agentIdForKey } from '../db/key-map.js';

export type RequestIdentity =
  | { kind: 'agent'; agentId: string }
  | { kind: 'session'; subject: string; agentIds: string[] };

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

export function authenticate(req: IncomingMessage): RequestIdentity | null {
  const token = extractToken(req);
  if (!token) return null;
  const agentId = agentIdForKey(token);
  return agentId === undefined ? null : { kind: 'agent', agentId };
}

export function allowedAgents(
  identity: RequestIdentity | undefined,
): Set<string> {
  if (identity?.kind === 'session') return new Set(identity.agentIds);
  if (identity?.kind === 'agent') return new Set([identity.agentId]);
  return new Set();
}
