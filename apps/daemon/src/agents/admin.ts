import { randomBytes } from 'node:crypto';
import { ApiError } from '@metro-labs/http/api-error';
import { AGENT_NAME_RE } from '@metro-labs/core/ids';

export class AgentAdminError extends ApiError {}

export interface AgentSummary {
  id: string;
  name: string | null;
}

export interface CreatedAgent {
  id: string;
  name: string | null;
  key: string;
}

export function normalizeAgentName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (!AGENT_NAME_RE.test(name))
    throw new AgentAdminError(
      'name must be 2-32 characters of A-Z, a-z, 0-9, - or _, starting with a letter or digit',
      400,
    );
  return name;
}

export function newApiKey(): string {
  return `mk_${randomBytes(32).toString('base64url')}`;
}
