import { daemonBase } from '../auth/daemon.js';
import { accessToken, refreshAccount } from './auth.js';
import { groupAccounts, isRecord, type AccountGroup } from './accounts.js';

export class AuthError extends Error {
  constructor(
    message: string,
    readonly refused = false,
  ) {
    super(message);
  }
}

export class StoppedError extends Error {}

export interface AgentSummary {
  id: string;
  name: string;
  connectorIds: string[];
}

export interface StationsView {
  agent: AgentSummary | undefined;
  groups: AccountGroup[];
  attachable: string[];
  unavailable: string[];
  capabilities: Record<string, string[]>;
}

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

async function sendBearer(url: string, init: CallInit, token: string): Promise<Response> {
  try {
    return await fetch(url, { method: init.method, headers: { authorization: `Bearer ${token}`, ...init.headers }, body: init.body });
  } catch {
    throw new Error('Failed to reach Metro.');
  }
}

function failure(res: Response, body: unknown): Error | null {
  if (res.status === 401) return new AuthError('not authorized', true);
  if (res.status === 503 && isRecord(body) && body.stopped === true) return new StoppedError(errorText(body, res.status));
  return res.ok ? null : new Error(errorText(body, res.status));
}

async function answered(init: CallInit): Promise<Response> {
  const url = `${init.base ?? agentsUrl()}${init.path ?? ''}`;
  const token = await accessToken();
  if (token === null) throw new AuthError('not signed in');
  const res = await sendBearer(url, init, token);
  if (res.status !== 401) return res;
  const again = await refreshAccount();
  if (again === null) throw new AuthError('not signed in');
  return sendBearer(url, init, again.accessToken);
}

export async function call(init: CallInit): Promise<unknown> {
  const res = await answered(init);
  const body: unknown = await res.json().catch(() => null);
  const failed = failure(res, body);
  if (failed !== null) throw failed;
  return body;
}

export async function callRaw(init: CallInit): Promise<Response> {
  const res = await answered(init);
  if (res.ok) return res;
  const failed = failure(res, await res.json().catch(() => null));
  throw failed ?? new Error(`Metro returned ${String(res.status)}.`);
}

function toAgent(value: unknown): AgentSummary | undefined {
  const first: unknown = Array.isArray(value) ? value[0] : undefined;
  if (!isRecord(first)) return undefined;
  return {
    id: typeof first.id === 'string' ? first.id : '',
    name: typeof first.name === 'string' ? first.name : '',
    connectorIds: toStationList(first.connector_ids),
  };
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

export async function fetchSession(): Promise<string> {
  const body = await call({ base: sessionUrl(), method: 'GET' });
  if (!isRecord(body) || typeof body.subject !== 'string')
    throw new Error('Metro returned an unexpected response.');
  return body.subject;
}

export async function fetchStations(): Promise<StationsView> {
  const body = await call({
    method: 'GET',
    path: '?accounts=1',
  });
  if (!isRecord(body)) throw new Error('Metro returned an unexpected response.');
  return {
    agent: toAgent(body.agents),
    groups: groupAccounts(body.accounts),
    attachable: toStationList(body.attachable),
    unavailable: toStationList(body.unavailable),
    capabilities: toCapabilities(body.capabilities),
  };
}

