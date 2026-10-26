import { filled, isRecord } from '../read.js';
import { builtInDaemon } from '../auth/daemon.js';
import { NotFoundError } from './client.js';
import { orgCall } from './org-connectors.js';

export type StatsRange = '24h' | '7d' | '30d' | '90d';

export const STATS_RANGES: { value: StatsRange; label: string }[] = [
  { value: '24h', label: '24 h' },
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: '90d', label: '90 days' },
];

export const DEFAULT_STATS_RANGE: StatsRange = '7d';

export const OTHER_CONNECTORS = '~other';

interface CallCount {
  total: number;
  failed: number;
}

export interface StatsBucket extends CallCount {
  at: number;
  byConnector: Record<string, CallCount>;
}

export interface StatsConnector extends CallCount {
  key: string;
  connector: string | null;
  name: string;
  url: string | null;
}

export interface StatsTotals {
  total: number;
  ok: number;
  failed: number;
  blocked: number;
  denied: number;
  waiting: number;
  p50Ms: number | null;
  p95Ms: number | null;
}

export interface ConnectorStats {
  range: StatsRange;
  bucketMs: number;
  buckets: StatsBucket[];
  connectors: StatsConnector[];
  totals: StatsTotals;
}

export interface StatsQuery {
  range: StatsRange;
  agent?: string | null;
  connector?: string | null;
}

export const unexpected = (): Error => new Error('Metro returned an unexpected response.');
export const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0);
export const ms = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null);
export const isRange = (value: unknown): value is StatsRange => STATS_RANGES.some((range) => range.value === value);

const callCount = (value: unknown): CallCount => (isRecord(value) ? { total: count(value.total), failed: count(value.failed) } : { total: 0, failed: 0 });

function bucketOf(value: unknown): StatsBucket | null {
  if (!isRecord(value) || typeof value.at !== 'number' || !Number.isFinite(value.at)) return null;
  const parts = isRecord(value.byConnector) ? Object.entries(value.byConnector).map(([key, part]): [string, CallCount] => [key, callCount(part)]) : [];
  return { at: value.at, ...callCount(value), byConnector: Object.fromEntries(parts) };
}

function connectorOf(value: unknown): StatsConnector | null {
  if (!isRecord(value) || typeof value.key !== 'string') return null;
  return { key: value.key, connector: filled(value.connector), name: typeof value.name === 'string' ? value.name : '', url: filled(value.url), ...callCount(value) };
}

function totalsOf(value: unknown): StatsTotals {
  const totals = isRecord(value) ? value : {};
  return {
    total: count(totals.total),
    ok: count(totals.ok),
    failed: count(totals.failed),
    blocked: count(totals.blocked),
    denied: count(totals.denied),
    waiting: count(totals.waiting),
    p50Ms: ms(totals.p50Ms),
    p95Ms: ms(totals.p95Ms),
  };
}

export const kept = <T>(rows: unknown, read: (value: unknown) => T | null): T[] => (Array.isArray(rows) ? rows.map(read).filter((row): row is T => row !== null) : []);

export function toConnectorStats(value: unknown): ConnectorStats {
  if (!isRecord(value) || !isRange(value.range) || !Array.isArray(value.buckets)) throw unexpected();
  return {
    range: value.range,
    bucketMs: count(value.bucketMs),
    buckets: kept(value.buckets, bucketOf),
    connectors: kept(value.connectors, connectorOf),
    totals: totalsOf(value.totals),
  };
}

function statsPath(query: StatsQuery): string {
  const params = new URLSearchParams({ range: query.range });
  if (query.agent !== undefined && query.agent !== null) params.set('agent', query.agent);
  if (query.connector !== undefined && query.connector !== null) params.set('connector', query.connector);
  return `/activity/stats?${params.toString()}`;
}

export async function fetchConnectorStats(query: StatsQuery, signal?: AbortSignal): Promise<ConnectorStats | null> {
  try {
    return toConnectorStats(await orgCall({ method: 'GET', base: `${builtInDaemon()}/api/connectors`, path: statsPath(query), signal }));
  } catch (err) {
    if (err instanceof NotFoundError) return null;
    throw err;
  }
}

export const isFilterable = (connector: StatsConnector): boolean => connector.key !== '' && connector.key !== OTHER_CONNECTORS;
