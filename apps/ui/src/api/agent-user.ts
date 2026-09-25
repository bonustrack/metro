import { daemonBase } from '../auth/daemon.js';
import { call } from './client.js';
import { awaitRestart } from './control.js';
import { filled, isRecord } from './read.js';

export const AGENT_USER_SINCE = '0.1.0-beta.184';

export interface AgentUserStatus {
  enabled: boolean;
  user: string | null;
  active: boolean;
  supported: boolean;
  reason: string | null;
}

export function toAgentUser(body: unknown): AgentUserStatus {
  if (!isRecord(body) || typeof body.enabled !== 'boolean') throw new Error('Metro returned an unexpected response.');
  return {
    enabled: body.enabled,
    user: filled(body.user),
    active: body.active === true,
    supported: body.supported === true,
    reason: filled(body.reason),
  };
}

export async function fetchAgentUser(): Promise<AgentUserStatus> {
  return toAgentUser(await call({ method: 'GET', base: `${daemonBase()}/api/agent-user` }));
}

export async function switchAgentUser(enabled: boolean): Promise<void> {
  const since = Date.now();
  await call({
    method: 'POST',
    base: `${daemonBase()}/api/agent-user`,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled }),
  });
  await awaitRestart(daemonBase(), since);
}

export const WORKSPACE_SINCE = '0.1.0-beta.187';

export interface WorkspaceEntry {
  name: string;
  kind: 'folder' | 'file' | 'link';
  bytes: number | null;
  state: 'here' | 'waiting' | 'copying' | 'moved' | 'failed';
  error: string | null;
}

const STATES = new Set(['here', 'waiting', 'copying', 'moved', 'failed']);

function toEntry(raw: unknown): WorkspaceEntry | null {
  if (!isRecord(raw) || typeof raw.name !== 'string') return null;
  const kind = raw.kind === 'file' || raw.kind === 'link' ? raw.kind : 'folder';
  const state = typeof raw.state === 'string' && STATES.has(raw.state) ? (raw.state as WorkspaceEntry['state']) : 'here';
  return { name: raw.name, kind, bytes: typeof raw.bytes === 'number' ? raw.bytes : null, state, error: filled(raw.error) };
}

export function toWorkspace(body: unknown): WorkspaceEntry[] {
  if (!isRecord(body) || !Array.isArray(body.entries)) throw new Error('Metro returned an unexpected response.');
  return body.entries.map(toEntry).filter((e): e is WorkspaceEntry => e !== null);
}

export async function fetchWorkspace(): Promise<WorkspaceEntry[]> {
  return toWorkspace(await call({ method: 'GET', base: `${daemonBase()}/api/agent-user/workspace` }));
}

export async function moveWorkspace(names: string[]): Promise<WorkspaceEntry[]> {
  return toWorkspace(
    await call({
      method: 'POST',
      base: `${daemonBase()}/api/agent-user/workspace`,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ names }),
    }),
  );
}
