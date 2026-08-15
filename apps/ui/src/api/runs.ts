import { daemonBase } from '../auth/session';
import { callUrl } from './client';
import { isRecord } from './accounts';
import { type Run, type RunState } from '../components/runs';
import { type AgentReport, type ReportRow } from '../components/report';

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

function toReportRow(raw: Record<string, unknown>): ReportRow | null {
  const kind = raw.kind === 'queue' ? 'queue' : raw.kind === 'agent' ? 'agent' : null;
  if (kind === null || typeof raw.id !== 'string' || typeof raw.state !== 'string')
    return null;
  return {
    kind,
    id: raw.id,
    state: raw.state,
    label: label(raw.label),
    who: label(raw.who),
    needs: Array.isArray(raw.needs)
      ? raw.needs.filter((n): n is string => typeof n === 'string')
      : [],
    blockedOn: label(raw.blocked_on),
    startedAt: at(raw.started_at),
    endedAt: at(raw.ended_at),
  };
}

function toReport(raw: Record<string, unknown>): AgentReport | null {
  const reportedAt = at(raw.reported_at);
  if (typeof raw.agent_id !== 'number' || reportedAt === null) return null;
  return {
    agentId: raw.agent_id,
    reportedAt,
    rows: Array.isArray(raw.rows)
      ? raw.rows
          .filter(isRecord)
          .map(toReportRow)
          .filter((r): r is ReportRow => r !== null)
      : [],
  };
}

export function toAgentReports(value: unknown): AgentReport[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isRecord)
    .map(toReport)
    .filter((r): r is AgentReport => r !== null);
}

export interface RunFeed {
  days: number;
  runs: Run[];
  reports: AgentReport[];
}

export async function fetchRuns(token: string, days: number): Promise<RunFeed> {
  const body = await callUrl(
    `${daemonBase()}/api/agent-runs?days=${days}`,
    token,
    { method: 'GET' },
  );
  if (!isRecord(body)) throw new Error('Metro returned an unexpected response.');
  return {
    days: num(body.days) || days,
    runs: toRuns(body.runs),
    reports: toAgentReports(body.reports),
  };
}
