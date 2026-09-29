import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus, freemem, homedir, totalmem } from 'node:os';
import { dirname, join } from 'node:path';
import { errMsg, log } from '@metro-labs/core/log';
import { ApiError } from '@metro-labs/http/api-error';
import { diskInfo } from './machine.js';

const SAMPLE_MS = 60_000;
const HOUR_MS = 3_600_000;
const KEEP_MS = 7 * 24 * HOUR_MS;
const POINTS = 240;
const COMPACT_EVERY = 1_440;
const RANGES: Readonly<Record<string, number>> = { '1h': HOUR_MS, '24h': 24 * HOUR_MS, '7d': KEEP_MS };
const FIELDS = ['at', 'cpu', 'memUsed', 'memTotal', 'diskUsed', 'diskTotal'] as const;

export type ResourceSample = Record<(typeof FIELDS)[number], number>;

interface CpuTicks {
  busy: number;
  total: number;
}

const state: { samples: ResourceSample[]; appended: number } = { samples: [], appended: 0 };

const resourcesFile = (): string => join(homedir(), '.metro', 'resources.jsonl');

function cpuTicks(): CpuTicks {
  let busy = 0;
  let total = 0;
  for (const { times } of cpus()) {
    const sum = times.user + times.nice + times.sys + times.idle + times.irq;
    total += sum;
    busy += sum - times.idle;
  }
  return { busy, total };
}

export function cpuPercent(before: CpuTicks, after: CpuTicks): number {
  const total = after.total - before.total;
  if (total <= 0) return 0;
  return Math.min(100, Math.max(0, ((after.busy - before.busy) / total) * 100));
}

function toSample(value: unknown): ResourceSample | null {
  if (typeof value !== 'object' || value === null) return null;
  const out: Partial<ResourceSample> = {};
  for (const field of FIELDS) {
    const v: unknown = (value as Record<string, unknown>)[field];
    if (typeof v !== 'number' || !Number.isFinite(v)) return null;
    out[field] = v;
  }
  return out as ResourceSample;
}

function parseLine(line: string): ResourceSample | null {
  if (line.trim() === '') return null;
  try {
    return toSample(JSON.parse(line));
  } catch {
    return null;
  }
}

const toLine = (sample: ResourceSample): string => `${JSON.stringify(sample)}\n`;

export function readSamples(file = resourcesFile(), now = Date.now()): ResourceSample[] {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  return text.split('\n').flatMap((line) => parseLine(line) ?? []).filter((s) => s.at > now - KEEP_MS);
}

function rewrite(file: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, state.samples.map(toLine).join(''));
  state.appended = 0;
}

export function recordSample(sample: ResourceSample, file = resourcesFile()): void {
  state.samples.push(sample);
  const first = state.samples.findIndex((s) => s.at > sample.at - KEEP_MS);
  if (first > 0) state.samples.splice(0, first);
  if (state.appended >= COMPACT_EVERY) {
    rewrite(file);
    return;
  }
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, toLine(sample));
  state.appended += 1;
}

export function loadSamples(file = resourcesFile()): void {
  state.samples = readSamples(file);
  state.appended = 0;
}

export async function takeSample(before: CpuTicks): Promise<{ sample: ResourceSample; ticks: CpuTicks }> {
  const ticks = cpuTicks();
  const disk = await diskInfo();
  const memTotal = totalmem();
  return {
    ticks,
    sample: {
      at: Date.now(),
      cpu: cpuPercent(before, ticks),
      memUsed: memTotal - freemem(),
      memTotal,
      diskUsed: disk === null ? 0 : disk.totalBytes - disk.freeBytes,
      diskTotal: disk?.totalBytes ?? 0,
    },
  };
}

export function startResourceSampler(): void {
  try {
    loadSamples();
    rewrite(resourcesFile());
  } catch (err) {
    log.warn({ err: errMsg(err) }, 'resources: could not load the history');
  }
  let ticks = cpuTicks();
  const run = (): void => {
    takeSample(ticks)
      .then((next) => {
        ticks = next.ticks;
        recordSample(next.sample);
      })
      .catch((err: unknown) => {
        log.warn({ err: errMsg(err) }, 'resources: could not record a sample');
      });
  };
  setInterval(run, SAMPLE_MS).unref?.();
}

function average(at: number, group: ResourceSample[]): ResourceSample {
  const mean = (field: (typeof FIELDS)[number]): number => group.reduce((sum, s) => sum + s[field], 0) / group.length;
  return { at, cpu: mean('cpu'), memUsed: mean('memUsed'), memTotal: mean('memTotal'), diskUsed: mean('diskUsed'), diskTotal: mean('diskTotal') };
}

export function resourceSeries(samples: ResourceSample[], rangeMs: number, now = Date.now()): { stepMs: number; samples: ResourceSample[] } {
  const stepMs = Math.max(1, Math.ceil(rangeMs / POINTS / SAMPLE_MS)) * SAMPLE_MS;
  const buckets = new Map<number, ResourceSample[]>();
  for (const sample of samples) {
    if (sample.at <= now - rangeMs || sample.at > now) continue;
    const key = Math.floor(sample.at / stepMs) * stepMs;
    const group = buckets.get(key);
    if (group === undefined) buckets.set(key, [sample]);
    else group.push(sample);
  }
  return { stepMs, samples: [...buckets].map(([at, group]) => average(at, group)) };
}

export function resourcesFor(range: string): { range: string; sampleMs: number; stepMs: number; samples: ResourceSample[] } {
  const rangeMs = Object.hasOwn(RANGES, range) ? RANGES[range] : undefined;
  if (rangeMs === undefined) throw new ApiError('range must be 1h, 24h or 7d', 400);
  return { range, sampleMs: SAMPLE_MS, ...resourceSeries(state.samples, rangeMs) };
}
