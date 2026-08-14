import { daemonBase } from '../auth/session';
import {
  attributeUntagged,
  groupAccounts,
  isRecord,
  unattributedAccounts,
  type AccountGroup,
} from './accounts';

export class AuthError extends Error {}

export interface AgentSummary {
  id: number;
  name: string;
  owned: boolean;
  key: string | null;
  endpoint: string | null;
  command: string | null;
}

export interface Dashboard {
  email: string;
  endpoint: string;
  agents: AgentSummary[];
  groups: AccountGroup[];
  unattributed: number;
  attachable: string[];
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

export interface CallInit {
  method: 'GET' | 'POST' | 'DELETE';
  path?: string;
  headers?: Record<string, string>;
  body?: string;
}

export async function callUrl(
  url: string,
  token: string,
  init: CallInit,
): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, {
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

export async function call(token: string, init: CallInit): Promise<unknown> {
  return callUrl(`${agentsUrl()}${init.path ?? ''}`, token, init);
}

const text = (value: unknown): string | null =>
  typeof value === 'string' && value !== '' ? value : null;

function credentials(a: Record<string, unknown>): Record<string, unknown> {
  if (a.key !== undefined || !Array.isArray(a.keys)) return a;
  const first: unknown = a.keys[0];
  return isRecord(first) ? first : {};
}

function toAgents(value: unknown): AgentSummary[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map((a) => {
    const cred = credentials(a);
    return {
      id: typeof a.id === 'number' ? a.id : 0,
      name: typeof a.name === 'string' ? a.name : '',
      owned: a.owned === true,
      key: text(cred.key),
      endpoint: text(cred.endpoint),
      command: text(cred.command),
    };
  });
}

function attributedGroups(
  agents: AgentSummary[],
  accounts: unknown,
): AccountGroup[] {
  const groups = groupAccounts(accounts);
  const sole = agents.length === 1 ? agents[0] : undefined;
  return sole === undefined ? groups : attributeUntagged(groups, sole.id);
}

function toStationList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((s): s is string => typeof s === 'string')
    : [];
}

export async function fetchDashboard(token: string): Promise<Dashboard> {
  const body = await call(token, { method: 'GET' });
  if (!isRecord(body)) throw new Error('Metro returned an unexpected response.');
  const agents = toAgents(body.agents);
  const groups = attributedGroups(agents, body.accounts);
  return {
    email: typeof body.email === 'string' ? body.email : '',
    endpoint: typeof body.endpoint === 'string' ? body.endpoint : '',
    agents,
    groups,
    unattributed: unattributedAccounts(groups),
    attachable: toStationList(body.attachable),
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

export async function resetAgentKey(
  token: string,
  id: number,
): Promise<CreatedAgent> {
  const body = await call(token, { method: 'POST', path: `/${id}/key` });
  if (
    !isRecord(body) ||
    typeof body.name !== 'string' ||
    typeof body.key !== 'string' ||
    typeof body.command !== 'string' ||
    typeof body.endpoint !== 'string'
  )
    throw new Error('Metro returned an unexpected response.');
  return {
    id: typeof body.id === 'number' ? body.id : id,
    name: body.name,
    key: body.key,
    endpoint: body.endpoint,
    command: body.command,
  };
}
