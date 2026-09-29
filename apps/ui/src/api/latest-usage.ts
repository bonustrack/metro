import { isRecord } from './read.js';
import { call } from './client.js';
import { percentLabel } from './resources.js';
import { builtInDaemon } from '../auth/daemon.js';

export interface LatestUsage {
  cpu: number | null;
  memory: number | null;
  disk: number | null;
}

const reading = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

export function toLatestUsage(body: unknown): Record<string, LatestUsage> {
  if (!isRecord(body) || !isRecord(body.servers)) throw new Error('Metro returned an unexpected response.');
  const out: Record<string, LatestUsage> = {};
  for (const [id, value] of Object.entries(body.servers))
    if (isRecord(value)) out[id] = { cpu: reading(value.cpu), memory: reading(value.memory), disk: reading(value.disk) };
  return out;
}

export async function fetchLatestUsage(): Promise<Record<string, LatestUsage>> {
  return toLatestUsage(await call({ method: 'GET', base: `${builtInDaemon()}/api/servers/usage` }));
}

export function latestLine(usage: LatestUsage): string {
  const parts: [string, number | null][] = [
    ['CPU', usage.cpu],
    ['Mem', usage.memory],
    ['Disk', usage.disk],
  ];
  const shown = parts.flatMap(([label, value]) => (value === null ? [] : [`${label} ${percentLabel(value)}`]));
  return shown.length === 0 ? 'No data' : shown.join(' · ');
}
