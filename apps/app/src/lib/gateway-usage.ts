import type { StatsRange } from '@metro-labs/client/api/connector-stats';
import { dollarsWords, OTHER_CONNECTIONS, type ConnectionUsage, type ModelUsage, type UsageTotals } from '@metro-labs/client/api/gateway-usage';
import { countWords, failedAlarm, percentWords, rangeWords, type StackSeries, type StatTile } from './call-stats.js';

type UsageMeasure = 'spend' | 'calls';

interface UsageColors {
  slots: readonly string[];
  other: string;
}

const MS_PER_SECOND = 1000;

const STEP_WORDS: Record<StatsRange, string> = { '24h': 'hour', '7d': '6 hours', '30d': 'day', '90d': 'day' };

export const callWords = (calls: number): string => (calls === 1 ? '1 call' : `${countWords(calls)} calls`);

export const chartTitle = (measure: UsageMeasure, range: StatsRange): string => `${measure === 'spend' ? 'Spend' : 'Model calls'} per ${STEP_WORDS[range]}`;

export function secondsWords(ms: number | null): string {
  if (ms === null) return 'No answer yet';
  if (ms < MS_PER_SECOND) return `${String(Math.round(ms))} ms`;
  return `${(ms / MS_PER_SECOND).toFixed(1)} s`;
}

export function connectionName(row: Pick<ConnectionUsage, 'connection' | 'label' | 'provider'>): string {
  if (row.connection === OTHER_CONNECTIONS) return 'Other accounts';
  if (row.connection === '') return 'No model set up';
  return row.label ?? (row.provider === null ? 'Removed account' : `Removed ${row.provider} account`);
}

const tokensIn = (totals: Pick<UsageTotals, 'inputTokens' | 'cacheReadTokens' | 'cacheWriteTokens'>): number => totals.inputTokens + totals.cacheReadTokens + totals.cacheWriteTokens;

export function usageTiles(totals: UsageTotals, range: StatsRange): StatTile[] {
  const sent = tokensIn(totals);
  return [
    {
      label: 'Spend',
      value: dollarsWords(totals.spendMicros),
      detail: totals.unpriced > 0 ? `${callWords(totals.unpriced)} on a plan or with no list price` : rangeWords(range),
      danger: false,
    },
    {
      label: 'Model calls',
      value: countWords(totals.calls),
      detail: `${percentWords(totals.failed, totals.calls)} failed, ${countWords(totals.limited)} over a limit`,
      danger: failedAlarm(totals.failed, totals.calls),
    },
    { label: 'Tokens in', value: countWords(sent), detail: `${percentWords(totals.cacheReadTokens, sent)} read from the cache`, danger: false },
    { label: 'Tokens out', value: countWords(totals.outputTokens), detail: 'Written by the models', danger: false },
    { label: 'First token', value: secondsWords(totals.p50FirstTokenMs), detail: `Typical. Slowest 5%: ${secondsWords(totals.p95FirstTokenMs)}`, danger: false },
  ];
}

export const usageMeasure = (usage: ModelUsage): UsageMeasure => (usage.totals.spendMicros > 0 ? 'spend' : 'calls');

function shownKeys(usage: ModelUsage): string[] {
  const seen = new Set(usage.buckets.flatMap((bucket) => Object.keys(bucket.byConnection)));
  const ranked = usage.connections.map((row) => row.connection).filter((key) => seen.has(key));
  return seen.has(OTHER_CONNECTIONS) ? [...ranked, OTHER_CONNECTIONS] : ranked;
}

export function usageSeries(usage: ModelUsage, measure: UsageMeasure, colors: UsageColors): StackSeries[] {
  const names = new Map(usage.connections.map((row) => [row.connection, connectionName(row)]));
  return shownKeys(usage).map((key, at) => ({
    key,
    label: names.get(key) ?? connectionName({ connection: key, label: null, provider: null }),
    url: null,
    color: key === OTHER_CONNECTIONS ? colors.other : (colors.slots[at % Math.max(1, colors.slots.length)] ?? colors.other),
    values: usage.buckets.map((bucket) => {
      const part = bucket.byConnection[key];
      return part === undefined ? 0 : measure === 'spend' ? part.spendMicros : part.calls;
    }),
    tip: true,
  }));
}

export function usageSummary(usage: ModelUsage): string {
  return `${dollarsWords(usage.totals.spendMicros)} ${rangeWords(usage.range)}, ${callWords(usage.totals.calls)}, ${percentWords(usage.totals.failed, usage.totals.calls)} failed`;
}
