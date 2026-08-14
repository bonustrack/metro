import { daemonBase } from '../auth/session';
import { callUrl } from './client';
import { isRecord } from './accounts';
import { type Run, type RunState } from '../components/runs';

const STATES = ['running', 'done', 'lost'];

const num = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0;

const label = (value: unknown): string | null =>
  typeof value === 'string' && value !== '' ? value : null;

function at(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

function state(value: unknown): RunState {
  return typeof value === 'string' && STATES.includes(value)
    ? (value as RunState)
    : 'lost';
}

function toRun(raw: Record<string, unknown>): Run | null {
  const startedAt = at(raw.started_at);
  if (typeof raw.id !== 'string' || startedAt === null) return null;
  return {
    agentId: num(raw.agent_id),
    id: raw.id,
    type: label(raw.type),
    label: label(raw.label),
    state: state(raw.state),
    startedAt,
    endedAt: at(raw.ended_at),
    turns: num(raw.turns),
    inputTokens: num(raw.input_tokens),
    outputTokens: num(raw.output_tokens),
    cacheReadTokens: num(raw.cache_read_tokens),
    cacheWriteTokens: num(raw.cache_write_tokens),
  };
}

export function toRuns(value: unknown): Run[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isRecord)
    .map(toRun)
    .filter((run): run is Run => run !== null);
}

export interface RunFeed {
  days: number;
  runs: Run[];
}

export async function fetchRuns(token: string, days: number): Promise<RunFeed> {
  const body = await callUrl(
    `${daemonBase()}/api/agent-runs?days=${days}`,
    token,
    { method: 'GET' },
  );
  if (!isRecord(body)) throw new Error('Metro returned an unexpected response.');
  return { days: num(body.days) || days, runs: toRuns(body.runs) };
}
