import { isRecord } from './accounts';
import { daemonBase, daemonHost } from '../auth/daemon';

export type DaemonMode = 'hosted' | 'linked' | 'local';

export interface ModeInfo {
  mode: DaemonMode;
  owner: string | null;
  project: string | null;
  version: string | null;
}

const MODES: DaemonMode[] = ['hosted', 'linked', 'local'];

const text = (value: unknown): string | null =>
  typeof value === 'string' && value !== '' ? value : null;

export function toMode(body: unknown): ModeInfo | null {
  if (!isRecord(body)) return null;
  const mode = MODES.find((m) => m === body.mode);
  if (mode === undefined) return null;
  return { mode, owner: text(body.owner), project: text(body.project), version: text(body.version) };
}

export function connectRefusal(info: ModeInfo): string | null {
  return info.mode === 'linked'
    ? 'That daemon runs an agent for metro.box (metro start) and has no pages of its own. Manage that agent on metro.box.'
    : null;
}

export async function fetchMode(base = daemonBase()): Promise<ModeInfo> {
  let res: Response;
  try {
    res = await fetch(`${base}/api/mode`);
  } catch {
    throw new Error(
      `No Metro daemon answered at ${daemonHost(base)}. Is it running, and is the port forwarded?`,
    );
  }
  const info = toMode(await res.json().catch(() => null));
  if (!res.ok || info === null)
    throw new Error(`${daemonHost(base)} did not answer like a Metro daemon.`);
  return info;
}
