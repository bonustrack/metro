import { filled, isRecord } from '../read.js';
import { builtInDaemon } from '../auth/daemon.js';
import { NotFoundError } from './client.js';
import { STATS_RANGES, type StatsRange } from './connector-stats.js';
import { orgCall } from './org-connectors.js';

export const OTHER_CONNECTIONS = '~other';

export interface UsagePart {
  calls: number;
  spendMicros: number;
}

export interface UsageBucket extends UsagePart {
  at: number;
  failed: number;
  byConnection: Record<string, UsagePart>;
}

export interface ConnectionUsage extends UsagePart {
  connection: string;
  provider: string | null;
  label: string | null;
  failed: number;
  unpriced: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface AgentUsage extends UsagePart {
  agent: string;
  name: string | null;
}

export interface UsageTotals {
  calls: number;
  ok: number;
  failed: number;
  limited: number;
  spendMicros: number;
  unpriced: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  p50FirstTokenMs: number | null;
  p95FirstTokenMs: number | null;
}

export interface ModelUsage {
  range: StatsRange;
  bucketMs: number;
  buckets: UsageBucket[];
  connections: ConnectionUsage[];
  agents: AgentUsage[];
  totals: UsageTotals;
}

export interface UsageQuery {
  range: StatsRange;
  agent?: string | null;
  connection?: string | null;
}

const MICROS = 1_000_000;

const unexpected = (): Error => new Error('Metro returned an unexpected response.');
const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0);
const ms = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null);
const isRange = (value: unknown): value is StatsRange => STATS_RANGES.some((range) => range.value === value);
const record = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {});

const partOf = (value: unknown): UsagePart => ({ calls: count(record(value).calls), spendMicros: count(record(value).spendMicros) });

function bucketOf(value: unknown): UsageBucket | null {
  if (!isRecord(value) || typeof value.at !== 'number' || !Number.isFinite(value.at)) return null;
  const parts = Object.entries(record(value.byConnection)).map(([key, part]): [string, UsagePart] => [key, partOf(part)]);
  return { at: value.at, ...partOf(value), failed: count(value.failed), byConnection: Object.fromEntries(parts) };
}

const tokensOf = (value: Record<string, unknown>): Pick<UsageTotals, 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens'> => ({
  inputTokens: count(value.inputTokens),
  outputTokens: count(value.outputTokens),
  cacheReadTokens: count(value.cacheReadTokens),
  cacheWriteTokens: count(value.cacheWriteTokens),
});

function connectionOf(value: unknown): ConnectionUsage | null {
  if (!isRecord(value) || typeof value.connection !== 'string') return null;
  return { connection: value.connection, provider: filled(value.provider), label: filled(value.label), ...partOf(value), failed: count(value.failed), unpriced: count(value.unpriced), ...tokensOf(value) };
}

function agentOf(value: unknown): AgentUsage | null {
  if (!isRecord(value) || typeof value.agent !== 'string') return null;
  return { agent: value.agent, name: filled(value.name), ...partOf(value) };
}

function totalsOf(value: unknown): UsageTotals {
  const totals = record(value);
  return {
    calls: count(totals.calls),
    ok: count(totals.ok),
    failed: count(totals.failed),
    limited: count(totals.limited),
    spendMicros: count(totals.spendMicros),
    unpriced: count(totals.unpriced),
    ...tokensOf(totals),
    p50FirstTokenMs: ms(totals.p50FirstTokenMs),
    p95FirstTokenMs: ms(totals.p95FirstTokenMs),
  };
}

const kept = <T>(rows: unknown, read: (value: unknown) => T | null): T[] => (Array.isArray(rows) ? rows.map(read).filter((row): row is T => row !== null) : []);

export function toModelUsage(value: unknown): ModelUsage {
  if (!isRecord(value) || !isRange(value.range) || !Array.isArray(value.buckets)) throw unexpected();
  return {
    range: value.range,
    bucketMs: count(value.bucketMs),
    buckets: kept(value.buckets, bucketOf),
    connections: kept(value.connections, connectionOf),
    agents: kept(value.agents, agentOf),
    totals: totalsOf(value.totals),
  };
}

function usagePath(query: UsageQuery): string {
  const params = new URLSearchParams({ range: query.range });
  if (query.agent !== undefined && query.agent !== null) params.set('agent', query.agent);
  if (query.connection !== undefined && query.connection !== null) params.set('connection', query.connection);
  return `/usage?${params.toString()}`;
}

export async function fetchModelUsage(query: UsageQuery, signal?: AbortSignal): Promise<ModelUsage | null> {
  try {
    return toModelUsage(await orgCall({ method: 'GET', base: `${builtInDaemon()}/api/models`, path: usagePath(query), signal }));
  } catch (err) {
    if (err instanceof NotFoundError) return null;
    throw err;
  }
}

export function dollarsWords(micros: number): string {
  const dollars = micros / MICROS;
  if (micros === 0) return '$0';
  if (dollars < 0.01) return '< $0.01';
  return `$${dollars.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
