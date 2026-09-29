import { filled, isRecord, str } from './read.js';
import { call, NotFoundError } from './client.js';
import { builtInDaemon } from '../auth/daemon.js';

export type ResourceRange = '1h' | '24h' | '7d';

export const RESOURCE_RANGES: { value: ResourceRange; label: string }[] = [
  { value: '1h', label: '1h' },
  { value: '24h', label: '24h' },
  { value: '7d', label: '7d' },
];

export interface Point {
  at: number;
  value: number;
}

export interface Series {
  stepMs: number;
  points: Point[];
}

export interface UsageCharts {
  available: true;
  region: string;
  from: number;
  to: number;
  cpu: Series;
  credits: Series;
  status: Series;
  memory: Series;
  disk: Series;
  note: string | null;
}

export type Usage = { available: false; reason: string } | UsageCharts;

const toPoint = (value: unknown): Point | null =>
  isRecord(value) && typeof value.at === 'number' && typeof value.value === 'number' && Number.isFinite(value.at) && Number.isFinite(value.value)
    ? { at: value.at, value: value.value }
    : null;

function toSeries(value: unknown): Series {
  if (!isRecord(value)) return { stepMs: 60_000, points: [] };
  const stepMs = typeof value.stepMs === 'number' && value.stepMs > 0 ? value.stepMs : 60_000;
  const points = Array.isArray(value.points) ? value.points.flatMap((p) => toPoint(p) ?? []) : [];
  return { stepMs, points: points.sort((a, b) => a.at - b.at) };
}

const time = (value: unknown, fallback: number): number => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);

export function toUsage(body: unknown, now = Date.now()): Usage {
  if (!isRecord(body)) throw new Error('Metro returned an unexpected response.');
  if (body.available !== true) return { available: false, reason: str(body.reason) || 'This server has no charts.' };
  const to = time(body.to, now);
  return {
    available: true,
    region: str(body.region),
    from: time(body.from, to - 3_600_000),
    to,
    cpu: toSeries(body.cpu),
    credits: toSeries(body.credits),
    status: toSeries(body.status),
    memory: toSeries(body.memory),
    disk: toSeries(body.disk),
    note: filled(body.note),
  };
}

export async function fetchUsage(serverId: string, range: ResourceRange): Promise<Usage | null> {
  try {
    return toUsage(await call({ method: 'GET', base: `${builtInDaemon()}/api/servers/${serverId}/usage?range=${range}` }));
  } catch (err) {
    if (err instanceof NotFoundError) return null;
    throw err;
  }
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

export const percentLabel = (value: number): string => `${String(Math.round(value))}%`;

export const creditsLabel = (value: number): string => `${String(Math.round(value))} credits`;

export function timeLabel(at: number, range: ResourceRange): string {
  const date = new Date(at);
  const time = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return range === '7d' ? `${date.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}` : time;
}

export interface Health {
  text: string;
  danger: boolean;
}

const STALE_MS = 30 * 60_000;

function failingSince(points: Point[]): number {
  let since = points.at(-1)?.at ?? 0;
  for (let i = points.length - 1; i >= 0 && (points[i]?.value ?? 0) >= 1; i -= 1) since = points[i]?.at ?? since;
  return since;
}

export function healthOf(usage: UsageCharts, range: ResourceRange): Health {
  const last = usage.cpu.points.at(-1);
  if (last === undefined) return { text: 'AWS has no readings in this range. The server was off, or it is new.', danger: true };
  const status = usage.status.points;
  if ((status.at(-1)?.value ?? 0) >= 1) return { text: `AWS status checks are failing since ${timeLabel(failingSince(status), range)}.`, danger: true };
  if (usage.to - last.at > Math.max(STALE_MS, 3 * usage.cpu.stepMs)) return { text: `No readings since ${timeLabel(last.at, range)}. The server may be stopped.`, danger: true };
  const failed = status.filter((p) => p.value >= 1);
  const lastFailure = failed.at(-1);
  if (lastFailure !== undefined)
    return { text: `AWS status checks failed ${failed.length === 1 ? 'once' : `${String(failed.length)} times`} in this range, last at ${timeLabel(lastFailure.at, range)}. They pass now.`, danger: false };
  return { text: 'Running. AWS status checks pass.', danger: false };
}
