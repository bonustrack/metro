import { filled, isRecord, str } from '../read.js';
import { call, NotFoundError } from './client.js';
import { builtInDaemon } from '../auth/daemon.js';

type GrowPhase = 'growing' | 'restarting' | 'done' | 'failed';

export interface GrowJob {
  from: number;
  to: number;
  restart: boolean;
  phase: GrowPhase;
  progress: number;
  error: string | null;
}

export interface DiskChange {
  state: string;
  progress: number;
  targetGib: number;
}

export type StorageView =
  | { growable: false; reason: string }
  | {
      growable: true;
      state: string;
      sizeGib: number;
      type: string;
      gbMonthUsd: number | null;
      options: number[];
      modification: DiskChange | null;
      job: GrowJob | null;
    };

const PHASES: GrowPhase[] = ['growing', 'restarting', 'done', 'failed'];
const APPLYING = ['modifying', 'optimizing'];

const storageUrl = (serverId: string): string => `${builtInDaemon()}/api/servers/${serverId}/storage`;
const whole = (value: unknown): number => (typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0);
const price = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null);

function toJob(value: unknown): GrowJob | null {
  if (!isRecord(value)) return null;
  const phase = PHASES.find((p) => p === value.phase);
  if (phase === undefined) return null;
  return { from: whole(value.from), to: whole(value.to), restart: value.restart === true, phase, progress: whole(value.progress), error: filled(value.error) };
}

function toChange(value: unknown): DiskChange | null {
  if (!isRecord(value) || typeof value.state !== 'string') return null;
  return { state: value.state, progress: whole(value.progress), targetGib: whole(value.targetGib) };
}

export function toStorageView(body: unknown): StorageView {
  if (!isRecord(body)) throw new Error('Metro returned an unexpected response.');
  if (body.growable !== true) return { growable: false, reason: str(body.reason) };
  return {
    growable: true,
    state: str(body.state) || 'unknown',
    sizeGib: whole(body.sizeGib),
    type: str(body.type),
    gbMonthUsd: price(body.gbMonthUsd),
    options: Array.isArray(body.options) ? body.options.filter((o): o is number => typeof o === 'number' && Number.isInteger(o) && o > 0) : [],
    modification: toChange(body.modification),
    job: toJob(body.job),
  };
}

export async function fetchStorage(serverId: string): Promise<StorageView | null> {
  try {
    return toStorageView(await call({ method: 'GET', base: storageUrl(serverId) }));
  } catch (err) {
    if (err instanceof NotFoundError) return null;
    throw err;
  }
}

export async function growDisk(serverId: string, sizeGib: number): Promise<StorageView> {
  return toStorageView(
    await call({ method: 'POST', base: storageUrl(serverId), headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sizeGib }) }),
  );
}

export const growRunning = (job: GrowJob | null): boolean => job !== null && job.phase !== 'done' && job.phase !== 'failed';

export const applying = (change: DiskChange | null): boolean => change !== null && APPLYING.includes(change.state);

const dollars = (usd: number): string => `$${usd < 10 ? usd.toFixed(2) : String(Math.round(usd))}`;

export const monthlyDisk = (sizeGib: number, gbMonthUsd: number): string => `${dollars(sizeGib * gbMonthUsd)}/month`;

export function diskText(sizeGib: number, type: string, gbMonthUsd: number | null): string {
  return [`${String(sizeGib)} GB`, type, gbMonthUsd === null ? '' : monthlyDisk(sizeGib, gbMonthUsd)].filter((part) => part !== '').join(' · ');
}

export function growText(job: GrowJob): string {
  if (job.phase === 'growing') return `AWS is growing the disk to ${String(job.to)} GB${job.progress > 0 ? ` (${String(job.progress)}%)` : ''}…`;
  if (job.phase === 'restarting') return 'Restarting the server so it uses the new space…';
  if (job.phase === 'failed') return job.error ?? 'Growing the disk failed.';
  return job.restart
    ? `Grown from ${String(job.from)} to ${String(job.to)} GB. The server restarted to use it and is back in about a minute.`
    : `Grown from ${String(job.from)} to ${String(job.to)} GB. The server uses it when it starts.`;
}
