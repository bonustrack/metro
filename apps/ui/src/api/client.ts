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
  id: string;
  name: string;
  owned: boolean;
  connected: boolean;
  lastSeen: string | null;
  key: string | null;
  endpoint: string | null;
  command: string | null;
}

export interface AgentsView {
  email: string;
  endpoint: string;
  agents: AgentSummary[];
}

export interface StationsView extends AgentsView {
  groups: AccountGroup[];
  unattributed: number;
  attachable: string[];
  unavailable: string[];
  capabilities: Record<string, string[]>;
}

export interface CreatedAgent {
  id: string;
  name: string;
  key: string;
  endpoint: string;
  command: string;
}

const agentsUrl = (): string => `${daemonBase()}/api/agents`;
const sessionUrl = (): string => `${daemonBase()}/api/session`;

function errorText(body: unknown, status: number): string {
  if (isRecord(body) && typeof body.error === 'string') return body.error;
  return `Metro returned ${status}.`;
}

export interface CallInit {
  method: 'GET' | 'POST' | 'DELETE';
  base?: string;
  path?: string;
  headers?: Record<string, string>;
  body?: string;
}

export async function call(token: string, init: CallInit): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${init.base ?? agentsUrl()}${init.path ?? ''}`, {
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
      id: typeof a.id === 'string' ? a.id : '',
      name: typeof a.name === 'string' ? a.name : '',
      owned: a.owned === true,
      connected: a.connected === true,
      lastSeen: text(a.last_seen),
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

function toCapabilities(value: unknown): Record<string, string[]> {
  if (!isRecord(value)) return {};
  const out: Record<string, string[]> = {};
  for (const [station, verbs] of Object.entries(value))
    out[station] = toStationList(verbs);
  return out;
}

function toAgentsView(body: Record<string, unknown>): AgentsView {
  return {
    email: typeof body.email === 'string' ? body.email : '',
    endpoint: typeof body.endpoint === 'string' ? body.endpoint : '',
    agents: toAgents(body.agents),
  };
}

export async function fetchSession(token: string): Promise<string> {
  const body = await call(token, { base: sessionUrl(), method: 'GET' });
  if (!isRecord(body) || typeof body.email !== 'string')
    throw new Error('Metro returned an unexpected response.');
  return body.email;
}

export async function fetchAgents(
  token: string,
  project: string,
): Promise<AgentsView> {
  const body = await call(token, { method: 'GET', path: `?project=${project}` });
  if (!isRecord(body)) throw new Error('Metro returned an unexpected response.');
  return toAgentsView(body);
}

export async function fetchStations(
  token: string,
  project: string,
): Promise<StationsView> {
  const body = await call(token, {
    method: 'GET',
    path: `?accounts=1&project=${project}`,
  });
  if (!isRecord(body)) throw new Error('Metro returned an unexpected response.');
  const view = toAgentsView(body);
  const groups = attributedGroups(view.agents, body.accounts);
  return {
    ...view,
    groups,
    unattributed: unattributedAccounts(groups),
    attachable: toStationList(body.attachable),
    unavailable: toStationList(body.unavailable),
    capabilities: toCapabilities(body.capabilities),
  };
}

export async function createAgent(
  token: string,
  project: string,
  name: string,
): Promise<CreatedAgent> {
  const body = await call(token, {
    method: 'POST',
    path: `?project=${project}`,
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
    id: typeof body.id === 'string' ? body.id : '',
    name: body.name,
    key: body.key,
    endpoint: body.endpoint,
    command: body.command,
  };
}

export async function deleteAgent(token: string, id: string): Promise<void> {
  await call(token, { method: 'DELETE', path: `/${id}` });
}

export async function resetAgentKey(
  token: string,
  id: string,
): Promise<void> {
  const body = await call(token, { method: 'POST', path: `/${id}/key` });
  if (
    !isRecord(body) ||
    typeof body.name !== 'string' ||
    typeof body.key !== 'string' ||
    typeof body.command !== 'string' ||
    typeof body.endpoint !== 'string'
  )
    throw new Error('Metro returned an unexpected response.');
}
