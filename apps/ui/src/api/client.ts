import { builtInDaemon, daemonBase } from '../auth/daemon';
import { activeIdentity, type Identity } from '../auth/identity';
import { signRequest } from '../vault/crypto';
import { attributeUntagged, groupAccounts, isRecord, type AccountGroup } from './accounts';

export class AuthError extends Error {
  constructor(
    message: string,
    readonly refused = false,
  ) {
    super(message);
  }
}

export interface AgentSummary {
  id: string;
  name: string;
  owned: boolean;
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
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  base?: string;
  path?: string;
  headers?: Record<string, string>;
  body?: string;
}

export type Registration = { ok: true; owner: string } | { ok: false; error: string };

export async function registerIdentity(identity: Identity, base = daemonBase()): Promise<Registration> {
  let res: Response;
  try {
    res = await fetch(`${base}/auth/identity`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ signature: identity.signature }),
    });
  } catch {
    return { ok: false, error: 'Failed to reach Metro.' };
  }
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) return { ok: false, error: errorText(body, res.status) };
  return { ok: true, owner: isRecord(body) && typeof body.owner === 'string' ? body.owner : '' };
}

async function send(url: string, init: CallInit, identity: Identity): Promise<Response> {
  const { pathname } = new URL(url);
  try {
    return await fetch(url, {
      method: init.method,
      headers: { authorization: await signRequest(identity, init.method, pathname), ...init.headers },
      body: init.body,
    });
  } catch {
    throw new Error('Failed to reach Metro.');
  }
}

const sameOrigin = (a: string, b: string): boolean => new URL(a).origin === new URL(b).origin;

export async function call(init: CallInit): Promise<unknown> {
  const identity = activeIdentity();
  if (identity === null) throw new AuthError('not signed in');
  const url = `${init.base ?? agentsUrl()}${init.path ?? ''}`;
  let res = await send(url, init, identity);
  if (res.status === 401 && sameOrigin(url, daemonBase()) && !sameOrigin(url, builtInDaemon())) {
    const registered = await registerIdentity(identity);
    if (!registered.ok) throw new AuthError(registered.error, true);
    res = await send(url, init, identity);
  }
  if (res.status === 401) throw new AuthError('not authorized', true);
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

export async function fetchSession(): Promise<string> {
  const body = await call({ base: sessionUrl(), method: 'GET' });
  if (!isRecord(body) || typeof body.subject !== 'string')
    throw new Error('Metro returned an unexpected response.');
  return body.subject;
}

export async function fetchStations(): Promise<StationsView> {
  const body = await call({
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

export async function createAgent(name: string): Promise<CreatedAgent> {
  const body = await call({
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

export async function resetAgentKey(id: string): Promise<void> {
  const body = await call({ method: 'POST', path: `/${id}/key` });
  if (!isRecord(body) || typeof body.key !== 'string')
    throw new Error('Metro returned an unexpected response.');
}
