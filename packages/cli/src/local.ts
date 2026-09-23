import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { localUrl } from './runtime.js';

const PROBE_MS = 3_000;

export interface LocalAgent {
  id: string;
  key: string;
}

export function agentsDir(): string {
  const explicit = process.env.METRO_AGENTS_DIR?.trim();
  return explicit !== undefined && explicit !== '' ? explicit : join(homedir(), '.metro', 'agents');
}

function agentFile(dir: string): { id?: unknown; key?: unknown; stations?: unknown } | null {
  try {
    return JSON.parse(readFileSync(join(dir, 'agent.json'), 'utf8')) as { id?: unknown; key?: unknown; stations?: unknown };
  } catch {
    return null;
  }
}

export function localAgent(dir = agentsDir()): LocalAgent | null {
  const file = agentFile(dir);
  return typeof file?.id === 'string' && typeof file.key === 'string' ? { id: file.id, key: file.key } : null;
}

export function localStations(dir = agentsDir()): string[] {
  const stations = agentFile(dir)?.stations;
  if (!Array.isArray(stations)) return [];
  const out = new Set<string>();
  for (const s of stations) {
    const station = (s as { station?: unknown }).station;
    if (typeof station === 'string') out.add(station);
  }
  return [...out].sort();
}

export async function localDaemonUp(base = localUrl()): Promise<boolean> {
  try {
    const res = await fetch(`${base}/api/mode`, { signal: AbortSignal.timeout(PROBE_MS) });
    const body = (await res.json()) as { mode?: unknown };
    return res.ok && body.mode === 'local';
  } catch {
    return false;
  }
}
