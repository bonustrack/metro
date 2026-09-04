import { randomBytes } from 'node:crypto';
import { ApiError } from '../daemon/api-error.js';
import { AGENT_NAME_RE } from './ids.js';

export class AgentAdminError extends ApiError {}

export interface AgentSummary {
  id: string;
  name: string;
  owned: boolean;
  key: string | null;
}

export interface CreatedAgent {
  id: string;
  name: string;
  key: string;
}

export interface OwnedAgent {
  id: string;
  name: string;
}

export type DeletedAgent = OwnedAgent;

export interface ResetAgentKey extends OwnedAgent {
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
