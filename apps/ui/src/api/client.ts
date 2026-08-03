import { daemonBase } from '../auth/session';
import { groupAccounts, isRecord, type AccountGroup } from './accounts';

export class AuthError extends Error {}

export interface AgentKey {
  name: string;
  key: string | null;
  endpoint: string | null;
  command: string | null;
}

export interface AgentSummary {
  id: number;
  name: string;
  owned: boolean;
  keys: AgentKey[];
}

export interface Dashboard {
  email: string;
  endpoint: string;
  agents: AgentSummary[];
  groups: AccountGroup[];
}

export interface CreatedAgent {
  id: number;
  name: string;
  key: string;
  endpoint: string;
  command: string;
}

const agentsUrl = (): string => `${daemonBase()}/api/agents`;

function errorText(body: unknown, status: number): string {
  if (isRecord(body) && typeof body.error === 'string') return body.error;
  return `Metro returned ${status}.`;
}

interface CallInit {
  method: 'GET' | 'POST' | 'DELETE';
  path?: string;
  headers?: Record<string, string>;
  body?: string;
}

async function call(token: string, init: CallInit): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${agentsUrl()}${init.path ?? ''}`, {
      method: init.method,
      headers: { authorization: `Bearer ${token}`, ...init.headers },
      body: init.body,
    });
  } catch {
    throw new Error('Failed to reach Metro.');
  }
  if (res.status === 401) throw new AuthError('not authorized');
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) throw new Error(errorText(body, res.status));
  return body;
}

const text = (value: unknown): string | null =>
  typeof value === 'string' && value !== '' ? value : null;

function toKey(value: unknown): AgentKey {
  if (typeof value === 'string')
    return { name: value, key: null, endpoint: null, command: null };
  if (!isRecord(value)) return { name: '', key: null, endpoint: null, command: null };
  return {
    name: text(value.name) ?? '',
    key: text(value.key),
    endpoint: text(value.endpoint),
    command: text(value.command),
  };
}

function toKeys(value: unknown): AgentKey[] {
  return Array.isArray(value) ? value.map(toKey) : [];
}

function toAgents(value: unknown): AgentSummary[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map((a) => ({
    id: typeof a.id === 'number' ? a.id : 0,
    name: typeof a.name === 'string' ? a.name : '',
    owned: a.owned === true,
    keys: toKeys(a.keys),
  }));
}

export async function fetchDashboard(token: string): Promise<Dashboard> {
  const body = await call(token, { method: 'GET' });
  if (!isRecord(body)) throw new Error('Metro returned an unexpected response.');
  return {
    email: typeof body.email === 'string' ? body.email : '',
    endpoint: typeof body.endpoint === 'string' ? body.endpoint : '',
    agents: toAgents(body.agents),
    groups: groupAccounts(body.accounts),
  };
}

export async function createAgent(token: string, name: string): Promise<CreatedAgent> {
  const body = await call(token, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (
    !isRecord(body) ||
    typeof body.name !== 'string' ||
    typeof body.key !== 'string' ||
    typeof body.command !== 'string' ||
    typeof body.endpoint !== 'string'
  )
    throw new Error('Metro returned an unexpected response.');
  return {
    id: typeof body.id === 'number' ? body.id : 0,
    name: body.name,
    key: body.key,
    endpoint: body.endpoint,
    command: body.command,
  };
}

export async function deleteAgent(token: string, id: number): Promise<void> {
  await call(token, { method: 'DELETE', path: `/${id}` });
}
