import { ApiError } from '@metro-labs/http/api-error';
import type { McpCallStore } from '@metro-labs/connectors/db/mcp-calls';
import type { CallStats, CallTotals, GroupCount, StatsScope } from '@metro-labs/connectors/db/mcp-call-stats';
import { agentOf, connectorOf } from './activity.js';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const TOP = 8;
const OTHER_KEY = '~other';
const OTHER_NAME = 'Other';

const RANGES = {
  '24h': { bucketMs: HOUR_MS, count: 24 },
  '7d': { bucketMs: 6 * HOUR_MS, count: 28 },
  '30d': { bucketMs: DAY_MS, count: 30 },
  '90d': { bucketMs: DAY_MS, count: 90 },
} as const;

type StatsRange = keyof typeof RANGES;

const DEFAULT_RANGE: StatsRange = '7d';

interface Count {
  total: number;
  failed: number;
}

interface StatsBucket extends Count {
  at: number;
  byConnector: Record<string, Count>;
}

interface StatsConnector extends Count {
  key: string;
  connector?: string;
  name: string;
  url?: string;
}

interface StatsAnswer {
  range: StatsRange;
  bucketMs: number;
  buckets: StatsBucket[];
  connectors: StatsConnector[];
  totals: CallTotals;
}

const isRange = (value: string): value is StatsRange => Object.hasOwn(RANGES, value);

function rangeOf(query: URLSearchParams): StatsRange {
  const raw = query.get('range');
  if (raw === null || raw === '') return DEFAULT_RANGE;
  if (!isRange(raw)) throw new ApiError(`range must be one of ${Object.keys(RANGES).join(', ')}`, 400);
  return raw;
}

function scopeOf(owner: string, query: URLSearchParams, range: StatsRange, now: number): StatsScope {
  const { bucketMs, count } = RANGES[range];
  const to = Math.floor(now / bucketMs) * bucketMs + bucketMs;
  const agent = agentOf(query);
  const connector = connectorOf(query);
  return { owner, from: to - count * bucketMs, to, bucketMs, ...(agent === undefined ? {} : { agent }), ...(connector === undefined ? {} : { connector }) };
}

const byCalls = (a: GroupCount, b: GroupCount): number => b.total - a.total || (a.group < b.group ? -1 : a.group > b.group ? 1 : 0);

function connectorView(row: GroupCount): StatsConnector {
  const name = row.current ?? row.stored ?? row.key;
  return {
    key: row.group,
    ...(row.connector === null ? {} : { connector: row.connector }),
    name,
    ...(row.url === null ? {} : { url: row.url }),
    total: row.total,
    failed: row.failed,
  };
}

const sum = (rows: Count[], field: keyof Count): number => rows.reduce((total, row) => total + row[field], 0);

function ranked(groups: GroupCount[]): { shown: StatsConnector[]; kept: Set<string> } {
  const order = [...groups].sort(byCalls);
  const top = order.slice(0, TOP);
  const rest = order.slice(TOP);
  const shown = top.map(connectorView);
  if (rest.length > 0) shown.push({ key: OTHER_KEY, name: OTHER_NAME, total: sum(rest, 'total'), failed: sum(rest, 'failed') });
  return { shown, kept: new Set(top.map((row) => row.group)) };
}

function bucketsOf(stats: CallStats, scope: StatsScope, count: number, kept: Set<string>): StatsBucket[] {
  const parts = Array.from({ length: count }, () => new Map<string, Count>());
  const buckets = parts.map((_, i) => ({ at: scope.from + i * scope.bucketMs, total: 0, failed: 0 }));
  for (const row of stats.slots) {
    const bucket = buckets[row.slot];
    const part = parts[row.slot];
    if (bucket === undefined || part === undefined) continue;
    bucket.total += row.total;
    bucket.failed += row.failed;
    const key = kept.has(row.group) ? row.group : OTHER_KEY;
    const held = part.get(key) ?? { total: 0, failed: 0 };
    part.set(key, { total: held.total + row.total, failed: held.failed + row.failed });
  }
  return buckets.map((bucket, i) => ({ ...bucket, byConnector: Object.fromEntries(parts[i] ?? []) }));
}

export async function connectorActivityStats(store: McpCallStore, owner: string, query: URLSearchParams, now: number): Promise<StatsAnswer> {
  const range = rangeOf(query);
  const scope = scopeOf(owner, query, range, now);
  const stats = await store.stats(scope);
  const { shown, kept } = ranked(stats.groups);
  return { range, bucketMs: scope.bucketMs, buckets: bucketsOf(stats, scope, RANGES[range].count, kept), connectors: shown, totals: stats.totals };
}
