import { filled, isRecord } from './read.js';
import { daemonBase, daemonHost } from '../auth/daemon.js';

export interface ModeInfo {
  mode: 'local';
  owner: string | null;
  version: string | null;
  stopped: boolean;
}

export function toMode(body: unknown): ModeInfo | null {
  if (!isRecord(body)) return null;
  if (body.mode !== 'local') return null;
  return {
    mode: 'local',
    owner: filled(body.owner),
    version: filled(body.version),
    stopped: body.stopped === true,
  };
}

export async function fetchMode(base = daemonBase()): Promise<ModeInfo> {
  let res: Response;
  try {
    res = await fetch(`${base}/api/mode`);
  } catch {
    throw new Error(
      `No Metro daemon answered at ${daemonHost(base)}. Is it running, and can this browser reach it?`,
    );
  }
  const info = toMode(await res.json().catch(() => null));
  if (!res.ok || info === null)
    throw new Error(`${daemonHost(base)} did not answer like a Metro daemon.`);
  return info;
}
