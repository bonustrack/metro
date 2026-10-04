import { filled, isRecord, str } from '../read.js';
import { call, NotFoundError } from './client.js';
import { builtInDaemon } from '../auth/daemon.js';

export interface ServerSize {
  type: string;
  vcpus: number | null;
  memoryMib: number | null;
  hourlyUsd: number | null;
}

type ResizePhase = 'stopping' | 'resizing' | 'starting' | 'restoring' | 'done' | 'failed';

export interface ResizeJob {
  from: string;
  to: string;
  phase: ResizePhase;
  error: string | null;
}

export type SizeView =
  | { resizable: false; reason: string }
  | { resizable: true; region: string; state: string; type: string; current: ServerSize; options: ServerSize[]; job: ResizeJob | null };

const PHASES: ResizePhase[] = ['stopping', 'resizing', 'starting', 'restoring', 'done', 'failed'];
const HOURS_A_MONTH = 730;
const STATES: Record<string, string> = { running: 'Running', stopped: 'Stopped', pending: 'Starting', stopping: 'Stopping', 'shutting-down': 'Shutting down', terminated: 'Terminated' };

const sizeUrl = (serverId: string): string => `${builtInDaemon()}/api/servers/${serverId}/size`;
const count = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null);

function toSize(value: unknown): ServerSize | null {
  if (!isRecord(value) || typeof value.type !== 'string' || value.type === '') return null;
  return { type: value.type, vcpus: count(value.vcpus), memoryMib: count(value.memoryMib), hourlyUsd: count(value.hourlyUsd) };
}

function toJob(value: unknown): ResizeJob | null {
  if (!isRecord(value)) return null;
  const phase = PHASES.find((p) => p === value.phase);
  if (phase === undefined) return null;
  return { from: str(value.from), to: str(value.to), phase, error: filled(value.error) };
}

export function toSizeView(body: unknown): SizeView {
  if (!isRecord(body)) throw new Error('Metro returned an unexpected response.');
  if (body.resizable !== true) return { resizable: false, reason: str(body.reason) };
  const type = str(body.type);
  return {
    resizable: true,
    region: str(body.region),
    state: str(body.state) || 'unknown',
    type,
    current: toSize(body.current) ?? { type, vcpus: null, memoryMib: null, hourlyUsd: null },
    options: Array.isArray(body.options) ? body.options.flatMap((o) => toSize(o) ?? []) : [],
    job: toJob(body.job),
  };
}

export async function fetchSize(serverId: string): Promise<SizeView | null> {
  try {
    return toSizeView(await call({ method: 'GET', base: sizeUrl(serverId) }));
  } catch (err) {
    if (err instanceof NotFoundError) return null;
    throw err;
  }
}

export async function resizeServer(serverId: string, type: string): Promise<SizeView> {
  return toSizeView(
    await call({ method: 'POST', base: sizeUrl(serverId), headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type }) }),
  );
}

export const jobRunning = (job: ResizeJob | null): boolean => job !== null && job.phase !== 'done' && job.phase !== 'failed';

const gb = (mib: number): string => `${String(Math.round((mib / 1024) * 10) / 10)} GB`;

export const monthlyLabel = (hourlyUsd: number): string => `$${String(Math.round(hourlyUsd * HOURS_A_MONTH))}/month`;

export function sizeText(size: ServerSize): string {
  const cpu = size.vcpus === null ? '' : `${String(size.vcpus)} vCPU${/^t\d/.test(size.type) ? ' (burstable)' : ''}`;
  const parts = [size.type, cpu, size.memoryMib === null ? '' : gb(size.memoryMib), size.hourlyUsd === null ? '' : monthlyLabel(size.hourlyUsd)];
  return parts.filter((part) => part !== '').join(' · ');
}

export const stateText = (state: string): string => STATES[state] ?? state;

export function phaseText(job: ResizeJob): string {
  if (job.phase === 'stopping') return 'Stopping the server…';
  if (job.phase === 'resizing') return `Changing it to ${job.to}…`;
  if (job.phase === 'starting') return 'Starting it again…';
  if (job.phase === 'restoring') return `Putting ${job.from} back…`;
  if (job.phase === 'failed') return job.error ?? 'The resize failed.';
  return job.from === job.to ? 'Started.' : `Resized from ${job.from} to ${job.to}.`;
}
