import { allowedAgents, type RequestIdentity } from './request-identity.js';

export function sessionScopeKey(identity: RequestIdentity): string {
  const ids = [...allowedAgents(identity)].sort();
  if (ids.length > 0) return `agents:${ids.join(',')}`;
  return `email:${identity.kind === 'google' ? identity.email : identity.agentId}`;
}

export type SessionOwnership = 'none' | 'mine' | 'theirs';

export type SessionRoute =
  | { kind: 'create'; adoptId?: string }
  | { kind: 'use' }
  | { kind: 'reject'; status: number; message: string };

export interface SessionRouteInput {
  isInitialize: boolean;
  presented: string | undefined;
  ownership: SessionOwnership;
  hasOwnSession: boolean;
}

const NO_SESSION_HEADER = 'Bad Request: Mcp-Session-Id header is required';
const NOT_FOUND = 'Session not found';

export function routeSession(input: SessionRouteInput): SessionRoute {
  if (input.isInitialize) return { kind: 'create' };
  if (input.presented === undefined)
    return input.hasOwnSession
      ? { kind: 'use' }
      : { kind: 'reject', status: 400, message: NO_SESSION_HEADER };
  if (input.ownership === 'mine') return { kind: 'use' };
  if (input.ownership === 'theirs')
    return { kind: 'reject', status: 404, message: NOT_FOUND };
  return { kind: 'create', adoptId: input.presented };
}
