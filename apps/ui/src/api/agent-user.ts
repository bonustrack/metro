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
export const SCHEDULES_SINCE = '0.1.0-beta.190';

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

export type MoveMode = 'copy' | 'move';

export async function moveWorkspace(names: string[], mode: MoveMode = 'copy'): Promise<WorkspaceEntry[]> {
  return toWorkspace(
    await call({
      method: 'POST',
      base: `${daemonBase()}/api/agent-user/workspace`,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ names, mode }),
    }),
  );
}

export interface ScheduledJob {
  id: string;
  kind: 'timer' | 'cron-root' | 'cron-agent';
  name: string;
  schedule: string;
  command: string;
  runsAs: string;
  next: string | null;
  last: string | null;
  lastResult: string | null;
  usesRoot: boolean;
  converted: boolean;
}

const KINDS = new Set(['timer', 'cron-root', 'cron-agent']);

function toJob(raw: unknown): ScheduledJob | null {
  if (!isRecord(raw) || typeof raw.id !== 'string' || typeof raw.kind !== 'string' || !KINDS.has(raw.kind)) return null;
  const s = (v: unknown): string => (typeof v === 'string' ? v : '');
  return {
    id: raw.id,
    kind: raw.kind as ScheduledJob['kind'],
    name: s(raw.name),
    schedule: s(raw.schedule),
    command: s(raw.command),
    runsAs: s(raw.runsAs),
    next: filled(raw.next),
    last: filled(raw.last),
    lastResult: filled(raw.lastResult),
    usesRoot: raw.usesRoot === true,
    converted: raw.converted === true,
  };
}

export interface Schedules {
  agentUser: string | null;
  jobs: ScheduledJob[];
}

export function toSchedules(body: unknown): Schedules {
  if (!isRecord(body) || !Array.isArray(body.jobs)) throw new Error('Metro returned an unexpected response.');
  return { agentUser: filled(body.agentUser), jobs: body.jobs.map(toJob).filter((j): j is ScheduledJob => j !== null) };
}

export async function fetchSchedules(): Promise<Schedules> {
  return toSchedules(await call({ method: 'GET', base: `${daemonBase()}/api/schedules` }));
}

export async function changeSchedule(id: string, action: 'agent' | 'root'): Promise<Schedules> {
  return toSchedules(
    await call({
      method: 'POST',
      base: `${daemonBase()}/api/schedules`,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, action }),
    }),
  );
}
