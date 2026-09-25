import { daemonBase } from '../auth/daemon.js';
import { call } from './client.js';
import { filled, isRecord } from './read.js';

export const SCHEDULES_SINCE = '0.1.0-beta.190';

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
  problem: string | null;
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
    problem: filled(raw.problem),
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

export async function retrySchedule(id: string): Promise<Schedules> {
  return toSchedules(
    await call({
      method: 'POST',
      base: `${daemonBase()}/api/schedules`,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id }),
    }),
  );
}
