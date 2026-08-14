export type RunState = 'running' | 'done' | 'lost';

export interface Run {
  agentId: number;
  id: string;
  type: string | null;
  label: string | null;
  state: RunState;
  startedAt: number;
  endedAt: number | null;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface DayBucket {
  day: string;
  runs: number;
  tokens: number;
  medianMs: number;
}

export interface Bar {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Summary {
  running: number;
  runs: number;
  tokens: number;
  medianMs: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

export const totalTokens = (run: Run): number =>
  run.inputTokens + run.outputTokens + run.cacheReadTokens + run.cacheWriteTokens;

export function durationMs(run: Run, now: number): number {
  const end = run.endedAt ?? now;
  return Math.max(0, end - run.startedAt);
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const lower = sorted[mid - 1] ?? 0;
  const upper = sorted[mid] ?? 0;
  return sorted.length % 2 === 1 ? upper : Math.round((lower + upper) / 2);
}

export function dayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function dayLabel(day: string): string {
  const month = MONTHS[Number(day.slice(5, 7)) - 1] ?? '';
  return `${month} ${Number(day.slice(8, 10))}`;
}

export function dayBuckets(runs: Run[], days: number, now: number): DayBucket[] {
  const start = Math.floor(now / DAY_MS) * DAY_MS - (days - 1) * DAY_MS;
  const keys = Array.from({ length: days }, (_, i) => dayKey(start + i * DAY_MS));
  const durations = new Map<string, number[]>(keys.map((k) => [k, []]));
  const buckets = new Map<string, DayBucket>(
    keys.map((k) => [k, { day: k, runs: 0, tokens: 0, medianMs: 0 }]),
  );
  for (const run of runs) {
    const bucket = buckets.get(dayKey(run.startedAt));
    if (bucket === undefined) continue;
    bucket.runs += 1;
    bucket.tokens += totalTokens(run);
    if (run.endedAt !== null)
      durations.get(bucket.day)?.push(durationMs(run, now));
  }
  for (const bucket of buckets.values())
    bucket.medianMs = median(durations.get(bucket.day) ?? []);
  return keys.map((k) => buckets.get(k) ?? { day: k, runs: 0, tokens: 0, medianMs: 0 });
}

export function summarize(runs: Run[], now: number): Summary {
  const ended = runs.filter((r) => r.endedAt !== null);
  return {
    running: runs.filter((r) => r.state === 'running').length,
    runs: runs.length,
    tokens: runs.reduce((sum, r) => sum + totalTokens(r), 0),
    medianMs: median(ended.map((r) => durationMs(r, now))),
  };
}

export function barLayout(
  values: number[],
  width: number,
  height: number,
  maxBar = 16,
  gap = 2,
): Bar[] {
  const slot = values.length === 0 ? 0 : width / values.length;
  const barWidth = Math.max(1, Math.min(maxBar, slot - gap));
  const top = Math.max(...values, 0);
  return values.map((value, i) => {
    const scaled = top === 0 ? 0 : (value / top) * height;
    return {
      x: Math.round((i * slot + (slot - barWidth) / 2) * 100) / 100,
      y: Math.round((height - scaled) * 100) / 100,
      width: Math.round(barWidth * 100) / 100,
      height: Math.round(scaled * 100) / 100,
    };
  });
}

export function barPath(bar: Bar, radius = 4): string {
  if (bar.height <= 0) return '';
  const base = bar.y + bar.height;
  const r = Math.min(radius, bar.width / 2, bar.height);
  const right = bar.x + bar.width;
  return [
    `M${bar.x} ${base}`,
    `L${bar.x} ${bar.y + r}`,
    `Q${bar.x} ${bar.y} ${bar.x + r} ${bar.y}`,
    `L${right - r} ${bar.y}`,
    `Q${right} ${bar.y} ${right} ${bar.y + r}`,
    `L${right} ${base}`,
    'Z',
  ].join(' ');
}

export function peakIndex(values: number[]): number {
  let at = 0;
  values.forEach((value, i) => {
    if (value > (values[at] ?? 0)) at = i;
  });
  return at;
}

export function formatCount(value: number): string {
  return value.toLocaleString('en-US');
}

export function formatTokens(value: number): string {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(value);
}

export function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
