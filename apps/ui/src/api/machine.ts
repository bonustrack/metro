import { call } from './client.js';
import { isRecord } from './accounts.js';
import { daemonBase } from '../auth/daemon.js';

export interface Machine {
  version: string | null;
  owner: string | null;
  hostname: string;
  platform: string;
  arch: string;
  port: number;
  publicUrl: string | null;
  uptimeSeconds: number;
  startedAt: string | null;
  bun: string | null;
  agentsDir: string;
  claudeDir: string;
  runtimeStore: string | null;
  disk: { path: string; totalBytes: number; freeBytes: number } | null;
}

const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);
const word = (value: unknown): string => text(value) ?? '';

function diskOf(value: unknown): Machine['disk'] {
  if (!isRecord(value) || typeof value.totalBytes !== 'number' || typeof value.freeBytes !== 'number') return null;
  return { path: word(value.path), totalBytes: value.totalBytes, freeBytes: value.freeBytes };
}

export function toMachine(body: unknown): Machine {
  if (!isRecord(body) || typeof body.hostname !== 'string') throw new Error('Metro returned an unexpected response.');
  return {
    version: text(body.version),
    owner: text(body.owner),
    hostname: body.hostname,
    platform: word(body.platform),
    arch: word(body.arch),
    port: typeof body.port === 'number' ? body.port : 0,
    publicUrl: text(body.publicUrl),
    uptimeSeconds: typeof body.uptimeSeconds === 'number' ? body.uptimeSeconds : 0,
    startedAt: text(body.startedAt),
    bun: text(body.bun),
    agentsDir: word(body.agentsDir),
    claudeDir: word(body.claudeDir),
    runtimeStore: text(body.runtimeStore),
    disk: diskOf(body.disk),
  };
}

export async function fetchMachine(): Promise<Machine> {
  return toMachine(await call({ method: 'GET', base: `${daemonBase()}/api/server` }));
}

const PLATFORMS: Record<string, string> = { linux: 'Linux', darwin: 'macOS', win32: 'Windows' };

export const systemLabel = (machine: Machine): string =>
  `${PLATFORMS[machine.platform] ?? machine.platform} ${machine.arch}`.trim();

const GB = 1024 * 1024 * 1024;
const gb = (bytes: number): string => `${(bytes / GB).toFixed(1)} GB`;

export const DISK_WARN = 0.9;

export function diskLabel(disk: NonNullable<Machine['disk']>): { text: string; full: boolean } {
  const used = disk.totalBytes - disk.freeBytes;
  const share = disk.totalBytes === 0 ? 0 : used / disk.totalBytes;
  return { text: `${gb(used)} of ${gb(disk.totalBytes)} used (${String(Math.round(share * 100))}%), ${gb(disk.freeBytes)} free`, full: share >= DISK_WARN };
}

export function uptimeLabel(seconds: number): string {
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  if (days > 0) return `${String(days)}d ${String(hours)}h`;
  if (hours > 0) return `${String(hours)}h ${String(minutes)}m`;
  return `${String(minutes)}m`;
}
