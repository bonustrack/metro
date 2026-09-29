import { isRecord } from './read.js';
import { call } from './client.js';
import { daemonBase } from '../auth/daemon.js';

export type ResourceRange = '1h' | '24h' | '7d';

export const RESOURCE_RANGES: { value: ResourceRange; label: string }[] = [
  { value: '1h', label: '1h' },
  { value: '24h', label: '24h' },
  { value: '7d', label: '7d' },
];

export const RANGE_MS: Record<ResourceRange, number> = { '1h': 3_600_000, '24h': 86_400_000, '7d': 604_800_000 };

const FIELDS = ['at', 'cpu', 'memUsed', 'memTotal', 'diskUsed', 'diskTotal'] as const;

export type ResourceSample = Record<(typeof FIELDS)[number], number>;

export interface Resources {
  stepMs: number;
  samples: ResourceSample[];
}

function toSample(value: unknown): ResourceSample | null {
  if (!isRecord(value)) return null;
  const out: Partial<ResourceSample> = {};
  for (const field of FIELDS) {
    const v = value[field];
    if (typeof v !== 'number' || !Number.isFinite(v)) return null;
    out[field] = v;
  }
  return out as ResourceSample;
}

export function toResources(body: unknown): Resources | null {
  if (!isRecord(body)) throw new Error('Metro returned an unexpected response.');
  const answer = body.resources;
  if (!isRecord(answer) || !Array.isArray(answer.samples)) return null;
  return {
    stepMs: typeof answer.stepMs === 'number' && answer.stepMs > 0 ? answer.stepMs : 60_000,
    samples: answer.samples.flatMap((s) => toSample(s) ?? []).sort((a, b) => a.at - b.at),
  };
}

export async function fetchResources(range: ResourceRange): Promise<Resources | null> {
  return toResources(await call({ method: 'GET', base: `${daemonBase()}/api/server?range=${range}` }));
}

export interface Point {
  at: number;
  value: number;
}

export function segments(points: Point[], stepMs: number): Point[][] {
  const out: Point[][] = [];
  let prev: Point | undefined;
  for (const point of points) {
    const last = out.at(-1);
    if (last === undefined || prev === undefined || point.at - prev.at > 2 * stepMs) out.push([point]);
    else last.push(point);
    prev = point;
  }
  return out;
}

export function nearest(points: Point[], at: number): Point | undefined {
  let best: Point | undefined;
  for (const point of points) if (best === undefined || Math.abs(point.at - at) < Math.abs(best.at - at)) best = point;
  return best;
}

const GB = 1024 * 1024 * 1024;

export const percentLabel = (value: number): string => `${String(Math.round(value))}%`;

export const bytesOfLabel = (used: number, total: number): string =>
  `${(used / GB).toFixed(1)} of ${(total / GB).toFixed(1)} GB (${String(total === 0 ? 0 : Math.round((used / total) * 100))}%)`;

export function timeLabel(at: number, range: ResourceRange): string {
  const date = new Date(at);
  const time = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return range === '7d' ? `${date.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}` : time;
}
