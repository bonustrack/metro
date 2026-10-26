import { filled, isRecord, recordOf } from '../read.js';
import type { Usage, UsageWindow } from './usage.js';
import { builtInDaemon } from '../auth/daemon.js';
import { NotFoundError } from './client.js';
import { count, isRange, kept, ms, unexpected, type StatsRange } from './connector-stats.js';
import { orgCall } from './org-connectors.js';

export const OTHER_CONNECTIONS = '~other';

interface UsagePart {
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


const partOf = (value: unknown): UsagePart => ({ calls: count(recordOf(value).calls), spendMicros: count(recordOf(value).spendMicros) });

function bucketOf(value: unknown): UsageBucket | null {
  if (!isRecord(value) || typeof value.at !== 'number' || !Number.isFinite(value.at)) return null;
  const parts = Object.entries(recordOf(value.byConnection)).map(([key, part]): [string, UsagePart] => [key, partOf(part)]);
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
  const totals = recordOf(value);
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

export interface GatewayWindow extends UsageWindow {
  connection: string;
  at: number;
}

const isoOf = (at: unknown): string | null => (typeof at === 'number' && Number.isFinite(at) && at > 0 ? new Date(at).toISOString() : null);

function gatewayWindowOf(value: unknown): GatewayWindow | null {
  if (!isRecord(value) || typeof value.connection !== 'string' || typeof value.label !== 'string' || typeof value.at !== 'number') return null;
  const used = typeof value.used === 'number' && Number.isFinite(value.used) ? Math.min(1, Math.max(0, value.used)) : null;
  return { connection: value.connection, label: value.label, used, resetAt: isoOf(value.resetAt), detail: filled(value.detail), at: value.at };
}

export const toGatewayWindows = (value: unknown): GatewayWindow[] => kept(recordOf(value).windows, gatewayWindowOf);

export async function fetchGatewayWindows(signal?: AbortSignal): Promise<GatewayWindow[]> {
  try {
    return toGatewayWindows(await orgCall({ method: 'GET', base: `${builtInDaemon()}/api/models`, path: '/windows', signal }));
  } catch (err) {
    if (err instanceof NotFoundError) return [];
    throw err;
  }
}

function mergedUsage(held: Usage[string] | undefined, windows: GatewayWindow[]): Usage[string] {
  const newest = Math.max(...windows.map((w) => w.at));
  const theirs = new Set(windows.map((w) => w.label));
  const own = (held?.windows ?? []).filter((w) => !theirs.has(w.label));
  const shown = windows.map(({ label, used, resetAt, detail }): UsageWindow => ({ label, used, resetAt, detail }));
  const at = held !== undefined && Date.parse(held.at) > newest ? held.at : new Date(newest).toISOString();
  return { windows: [...shown, ...own], note: held?.note ?? null, at, tally: held?.tally ?? null };
}

export function withGatewayWindows(usage: Usage, windows: GatewayWindow[]): Usage {
  if (windows.length === 0) return usage;
  const byConnection = new Map<string, GatewayWindow[]>();
  for (const w of windows) byConnection.set(w.connection, [...(byConnection.get(w.connection) ?? []), w]);
  const merged = [...byConnection].map(([connection, rows]): [string, Usage[string]] => [connection, mergedUsage(usage[connection], rows)]);
  return { ...usage, ...Object.fromEntries(merged) };
}
