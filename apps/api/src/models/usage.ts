import { parseId } from '@metro-labs/core/ids';
import { ApiError } from '@metro-labs/http/api-error';
import type { AgentUsage, ConnectionUsage, ModelStats, ModelStatsScope, ModelTotals, ModelUsageStore } from '@metro-labs/connectors/db/model-call-stats';
import type { ModelWindowRow } from '@metro-labs/connectors/db/model-calls';
import { agentOf } from '../connectors/activity.js';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const TOP_CONNECTIONS = 8;
const TOP_AGENTS = 20;
const OTHER_KEY = '~other';

const RANGES = {
  '24h': { bucketMs: HOUR_MS, count: 24 },
  '7d': { bucketMs: 6 * HOUR_MS, count: 28 },
  '30d': { bucketMs: DAY_MS, count: 30 },
  '90d': { bucketMs: DAY_MS, count: 90 },
} as const;

type UsageRange = keyof typeof RANGES;

const DEFAULT_RANGE: UsageRange = '7d';

interface Part {
  calls: number;
  spendMicros: number;
}

interface UsageBucket extends Part {
  at: number;
  failed: number;
  byConnection: Record<string, Part>;
}

interface UsageAnswer {
  range: UsageRange;
  bucketMs: number;
  buckets: UsageBucket[];
  connections: ConnectionUsage[];
  agents: AgentUsage[];
  totals: ModelTotals;
}

const isRange = (value: string): value is UsageRange => Object.hasOwn(RANGES, value);

function rangeOf(query: URLSearchParams): UsageRange {
  const raw = query.get('range');
  if (raw === null || raw === '') return DEFAULT_RANGE;
  if (!isRange(raw)) throw new ApiError(`range must be one of ${Object.keys(RANGES).join(', ')}`, 400);
  return raw;
}

function connectionOf(query: URLSearchParams): string | undefined {
  const raw = query.get('connection');
  if (raw === null || raw === '') return undefined;
  const id = parseId(raw);
  if (id === null) throw new ApiError('connection must be an account id', 400);
  return id;
}

function scopeOf(owner: string, query: URLSearchParams, range: UsageRange, now: number): ModelStatsScope {
  const { bucketMs, count } = RANGES[range];
  const to = Math.floor(now / bucketMs) * bucketMs + bucketMs;
  const agent = agentOf(query);
  const connection = connectionOf(query);
  return { owner, from: to - count * bucketMs, to, bucketMs, ...(agent === undefined ? {} : { agent }), ...(connection === undefined ? {} : { connection }) };
}

const bySpend = <T extends { spendMicros: number; calls: number }>(a: T, b: T): number => b.spendMicros - a.spendMicros || b.calls - a.calls;

function bucketsOf(stats: ModelStats, scope: ModelStatsScope, count: number, kept: Set<string>): UsageBucket[] {
  const buckets: UsageBucket[] = Array.from({ length: count }, (_, i) => ({ at: scope.from + i * scope.bucketMs, calls: 0, failed: 0, spendMicros: 0, byConnection: {} }));
  for (const row of stats.slots) {
    const bucket = buckets[row.slot];
    if (bucket === undefined) continue;
    bucket.calls += row.calls;
    bucket.failed += row.failed;
    bucket.spendMicros += row.spendMicros;
    const key = kept.has(row.connection) ? row.connection : OTHER_KEY;
    const held = bucket.byConnection[key] ?? { calls: 0, spendMicros: 0 };
    bucket.byConnection[key] = { calls: held.calls + row.calls, spendMicros: held.spendMicros + row.spendMicros };
  }
  return buckets;
}

export async function modelUsage(store: ModelUsageStore, owner: string, query: URLSearchParams, now: number): Promise<UsageAnswer> {
  const range = rangeOf(query);
  const scope = scopeOf(owner, query, range, now);
  const stats = await store.stats(scope);
  const connections = [...stats.connections].sort(bySpend);
  const kept = new Set(connections.slice(0, TOP_CONNECTIONS).map((row) => row.connection));
  return {
    range,
    bucketMs: scope.bucketMs,
    buckets: bucketsOf(stats, scope, RANGES[range].count, kept),
    connections,
    agents: [...stats.agents].sort(bySpend).slice(0, TOP_AGENTS),
    totals: stats.totals,
  };
}

type WindowView = Omit<ModelWindowRow, 'owner'>;

const windowView = (row: ModelWindowRow): WindowView => ({ connection: row.connection, label: row.label, used: row.used, resetAt: row.resetAt, detail: row.detail, at: row.at });

export async function modelWindows(store: ModelUsageStore, owner: string): Promise<{ windows: WindowView[] }> {
  return { windows: (await store.windows(owner)).map(windowView) };
}
