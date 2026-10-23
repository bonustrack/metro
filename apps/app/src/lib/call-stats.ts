import { OTHER_CONNECTORS, type ConnectorStats, type StatsConnector, type StatsRange, type StatsTotals } from '@metro-labs/client/api/connector-stats';
import { durationWords } from './activity-words.js';

export type ChartMode = 'all' | 'connector';

export interface StackSeries {
  key: string;
  label: string;
  url: string | null;
  color: string;
  values: number[];
  tip: boolean;
}

export interface SeriesColors {
  slots: readonly string[];
  other: string;
  calls: string;
  failed: string;
}

const PER_WORDS: Record<StatsRange, string> = { '24h': 'Calls per hour', '7d': 'Calls per 6 hours', '30d': 'Calls per day', '90d': 'Calls per day' };

const RANGE_WORDS: Record<StatsRange, string> = { '24h': 'in the last 24 hours', '7d': 'in the last 7 days', '30d': 'in the last 30 days', '90d': 'in the last 90 days' };

const LABEL_STEPS: Record<StatsRange, readonly number[]> = { '24h': [2, 3, 4, 6, 12], '7d': [4, 8, 12, 28], '30d': [3, 5, 7, 10, 15], '90d': [7, 14, 15, 30, 45] };

const TICK_STEPS = Array.from({ length: 13 }, (_, power) => [1, 2, 5].map((base) => base * 10 ** power)).flat();
const MAX_INTERVALS = 4;
const COMPACT_FROM = 10_000;
const FAILED_ALARM = 0.05;

export const emptyCalls = (connector: string | null): string =>
  connector === null ? 'No connector calls yet. Calls appear here as your agents use their connectors.' : 'No calls to this connector yet.';

export const rangeWords = (range: StatsRange): string => RANGE_WORDS[range];

export const perWords = (range: StatsRange): string => PER_WORDS[range];

export const connectorName = (connector: Pick<StatsConnector, 'name' | 'key'>): string => (connector.name === '' ? (connector.key === '' ? 'Unknown connector' : connector.key) : connector.name);

export function connectorSlots(connectors: StatsConnector[], order: readonly string[], slots: number): Map<string, number> {
  const position = new Map(order.map((id, i) => [id, i]));
  const unknown = connectors.filter((one) => one.key !== OTHER_CONNECTORS && !position.has(one.connector ?? '')).map((one) => one.key).sort();
  const wanted = (one: StatsConnector): number => position.get(one.connector ?? '') ?? order.length + unknown.indexOf(one.key);
  const taken = new Set<number>();
  const out = new Map<string, number>();
  const named = connectors.filter((one) => one.key !== OTHER_CONNECTORS).sort((a, b) => wanted(a) - wanted(b));
  for (const one of named) {
    const first = wanted(one) % slots;
    const slot = Array.from({ length: slots }, (_, i) => (first + i) % slots).find((candidate) => !taken.has(candidate)) ?? first;
    taken.add(slot);
    out.set(one.key, slot);
  }
  return out;
}

export function stackSeries(stats: ConnectorStats, mode: ChartMode, colors: SeriesColors, order: readonly string[]): StackSeries[] {
  if (mode === 'all')
    return [
      { key: 'failed', label: 'Failed', url: null, color: colors.failed, values: stats.buckets.map((bucket) => bucket.failed), tip: true },
      { key: 'calls', label: 'Calls', url: null, color: colors.calls, values: stats.buckets.map((bucket) => bucket.total - bucket.failed), tip: false },
    ];
  const slots = connectorSlots(stats.connectors, order, colors.slots.length);
  const values = (key: string): number[] => stats.buckets.map((bucket) => bucket.byConnector[key]?.total ?? 0);
  const named = stats.connectors
    .filter((one) => one.key !== OTHER_CONNECTORS)
    .sort((a, b) => (slots.get(a.key) ?? 0) - (slots.get(b.key) ?? 0))
    .map((one) => ({ key: one.key, label: connectorName(one), url: one.url, color: colors.slots[slots.get(one.key) ?? 0] ?? colors.calls, values: values(one.key), tip: true }));
  const other = stats.connectors.find((one) => one.key === OTHER_CONNECTORS);
  return other === undefined ? named : [...named, { key: other.key, label: connectorName(other), url: null, color: colors.other, values: values(other.key), tip: true }];
}

export function niceTicks(max: number): number[] {
  const top = Math.max(1, Math.ceil(max));
  const step = TICK_STEPS.find((candidate) => Math.ceil(top / candidate) <= MAX_INTERVALS) ?? top;
  return Array.from({ length: Math.ceil(top / step) + 1 }, (_, i) => i * step);
}

export function labelIndices(range: StatsRange, count: number, maxLabels: number): number[] {
  const steps = LABEL_STEPS[range];
  const step = steps.find((candidate) => Math.ceil(count / candidate) <= Math.max(1, maxLabels)) ?? steps.at(-1) ?? count;
  const out: number[] = [];
  for (let i = count - 1; i >= 0; i -= step) out.unshift(i);
  return out;
}

export function countWords(count: number): string {
  if (count < COMPACT_FROM) return count.toLocaleString();
  return new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(count);
}

export const failedAlarm = (failed: number, total: number): boolean => total > 0 && failed / total >= FAILED_ALARM;

export function percentWords(part: number, total: number): string {
  if (total <= 0 || part <= 0) return '0%';
  const share = (part / total) * 100;
  if (share < 0.1) return '<0.1%';
  if (share < 10) return `${String(Math.round(share * 10) / 10)}%`;
  return `${String(Math.round(share))}%`;
}

export const callsWords = (count: number): string => (count === 1 ? '1 call' : `${countWords(count)} calls`);

const DAY_MS = 24 * 3_600_000;
const TIME: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit' };
const DAY: Intl.DateTimeFormatOptions = { weekday: 'short', month: 'short', day: 'numeric' };

export function axisWords(at: number, range: StatsRange): string {
  const date = new Date(at);
  if (range === '24h') return date.toLocaleTimeString(undefined, TIME);
  if (range === '7d') return date.toLocaleDateString(undefined, { weekday: 'short' });
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function bucketWords(at: number, bucketMs: number): string {
  const start = new Date(at);
  const end = new Date(at + bucketMs);
  if (bucketMs >= DAY_MS) return start.toLocaleDateString(undefined, DAY);
  const times = `${start.toLocaleTimeString(undefined, TIME)} to ${end.toLocaleTimeString(undefined, TIME)}`;
  return bucketMs >= 6 * 3_600_000 ? `${start.toLocaleDateString(undefined, DAY)}, ${times}` : times;
}

export interface StatTile {
  label: string;
  value: string;
  detail: string;
  danger: boolean;
}

const noneOr = (count: number, words: string): string => (count === 0 ? 'None' : words);

const blockedWords = (totals: StatsTotals): string =>
  noneOr(totals.blocked, totals.denied === 0 ? callsWords(totals.blocked) : `${callsWords(totals.blocked)}, ${countWords(totals.denied)} denied by you`);

export function statTiles(totals: StatsTotals, range: StatsRange): StatTile[] {
  return [
    { label: 'Calls', value: countWords(totals.total), detail: rangeWords(range), danger: false },
    { label: 'Failed', value: percentWords(totals.failed, totals.total), detail: noneOr(totals.failed, callsWords(totals.failed)), danger: failedAlarm(totals.failed, totals.total) },
    { label: 'Blocked by rules', value: percentWords(totals.blocked, totals.total), detail: blockedWords(totals), danger: false },
    { label: 'Waiting for approval', value: countWords(totals.waiting), detail: 'asked you first', danger: false },
    { label: 'Typical time', value: totals.p50Ms === null ? 'None' : durationWords(totals.p50Ms), detail: 'half the calls were faster', danger: false },
    { label: 'Slowest 5%', value: totals.p95Ms === null ? 'None' : durationWords(totals.p95Ms), detail: 'took at least this long', danger: false },
  ];
}
