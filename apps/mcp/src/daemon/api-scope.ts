import type { IncomingMessage } from 'node:http';
import {
  allowedAgents,
  authConfigFromEnv,
  authenticate,
} from '../mcp/request-identity.js';
import { ApiError } from './api-error.js';

export const identityScope = (req: IncomingMessage): Set<number> =>
  allowedAgents(authenticate(req, authConfigFromEnv()) ?? undefined);

export function ownerFromScope(
  req: IncomingMessage,
  allowed: Set<number>,
): number {
  const requested = new URL(req.url ?? '/', 'http://localhost').searchParams.get(
    'agent',
  );
  if (requested !== null) {
    const id = Number(requested);
    if (!Number.isInteger(id) || !allowed.has(id))
      throw new ApiError(`agent ${requested} is outside your scope`, 403);
    return id;
  }
  const [only] = [...allowed];
  if (allowed.size === 1 && only !== undefined) return only;
  throw new ApiError(
    `this credential covers ${allowed.size} agents; ` +
      'name the owning agent with ?agent=<id>',
    400,
  );
}
