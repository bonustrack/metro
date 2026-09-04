import { daemonBase } from '../auth/session';
import { attributeUntagged, groupAccounts, isRecord, type AccountGroup } from './accounts';

export class AuthError extends Error {}

export interface AgentSummary {
  id: string;
  name: string;
  owned: boolean;
  runtime: string | null;
  key: string | null;
  command: string | null;
  connectorIds: string[];
}

export interface AgentsView {
  agents: AgentSummary[];
}

export interface StationsView extends AgentsView {
  groups: AccountGroup[];
  attachable: string[];
  unavailable: string[];
  capabilities: Record<string, string[]>;
}

export interface CreatedAgent {
  name: string;
  key: string;
  command: string;
}

export const LOCAL_PROJECT = 'localdaemon';
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

function toAgents(value: unknown): AgentSummary[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map((a) => ({
    id: typeof a.id === 'string' ? a.id : '',
    name: typeof a.name === 'string' ? a.name : '',
    owned: a.owned === true,
    runtime: text(a.runtime),
    key: text(a.key),
    command: text(a.command),
    connectorIds: toStationList(a.connector_ids),
  }));
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

const toAgentsView = (body: Record<string, unknown>): AgentsView => ({ agents: toAgents(body.agents) });

export async function fetchSession(token: string): Promise<string> {
  const body = await call(token, { base: sessionUrl(), method: 'GET' });
  if (!isRecord(body) || typeof body.subject !== 'string')
    throw new Error('Metro returned an unexpected response.');
  return body.subject;
}

export async function fetchAgentsAt(
  token: string,
  project: string,
  daemon: string,
): Promise<AgentsView> {
  const body = await call(token, {
    method: 'GET',
    path: `?project=${project}`,
    base: `${daemon}/api/agents`,
  });
  if (!isRecord(body)) throw new Error('Metro returned an unexpected response.');
  return toAgentsView(body);
}

export async function fetchAgents(token: string): Promise<AgentsView> {
  const body = await call(token, { method: 'GET', path: `?project=${LOCAL_PROJECT}` });
  if (!isRecord(body)) throw new Error('Metro returned an unexpected response.');
  return toAgentsView(body);
}

export async function fetchStations(token: string): Promise<StationsView> {
  const body = await call(token, {
    method: 'GET',
    path: `?accounts=1&project=${LOCAL_PROJECT}`,
  });
  if (!isRecord(body)) throw new Error('Metro returned an unexpected response.');
  const view = toAgentsView(body);
  const groups = attributedGroups(view.agents, body.accounts);
  return {
    ...view,
    groups,
    attachable: toStationList(body.attachable),
    unavailable: toStationList(body.unavailable),
    capabilities: toCapabilities(body.capabilities),
  };
}

export async function createAgent(token: string, name: string): Promise<CreatedAgent> {
  const body = await call(token, {
    method: 'POST',
    path: `?project=${LOCAL_PROJECT}`,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (
    !isRecord(body) ||
    typeof body.name !== 'string' ||
    typeof body.key !== 'string' ||
    typeof body.command !== 'string'
  )
    throw new Error('Metro returned an unexpected response.');
  return { name: body.name, key: body.key, command: body.command };
}

export interface ImportedAgent {
  id: string;
  name: string;
  stations: number;
  connectors: number;
}

export async function importAgent(token: string, code: string): Promise<ImportedAgent> {
  const body = await call(token, {
    method: 'POST',
    path: '/import',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  if (!isRecord(body) || typeof body.id !== 'string' || typeof body.name !== 'string')
    throw new Error('Metro returned an unexpected response.');
  return {
    id: body.id,
    name: body.name,
    stations: typeof body.stations === 'number' ? body.stations : 0,
    connectors: typeof body.connectors === 'number' ? body.connectors : 0,
  };
}

export async function resetAgentKey(
  token: string,
  id: string,
): Promise<void> {
  const body = await call(token, { method: 'POST', path: `/${id}/key` });
  if (!isRecord(body) || typeof body.key !== 'string')
    throw new Error('Metro returned an unexpected response.');
}
