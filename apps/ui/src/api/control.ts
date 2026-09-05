import { daemonBase, daemonHost } from '../auth/daemon';
import { isRecord } from './accounts';
import { call } from './client';
import { fetchMode } from './mode';

export type DaemonState = 'live' | 'stopped' | 'offline';

export interface Pace {
  everyMs: number;
  maxMs: number;
}

const POLL_MS = 2_000;
const DOWN_MAX_MS = 20_000;
const UP_MAX_MS = 3 * 60_000;

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function stopDaemon(): Promise<void> {
  await call({ method: 'POST', base: `${daemonBase()}/api/stop` });
}

export async function restartDaemon(): Promise<void> {
  await call({ method: 'POST', base: `${daemonBase()}/api/restart` });
}

export async function startDaemon(base = daemonBase()): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${base}/api/start`, { method: 'POST' });
  } catch {
    throw new Error(`No Metro daemon answered at ${daemonHost(base)}. Is metro serve running there?`);
  }
  if (res.ok) return;
  const body: unknown = await res.json().catch(() => null);
  throw new Error(
    isRecord(body) && typeof body.error === 'string' ? body.error : `Metro returned ${String(res.status)}.`,
  );
}

export const daemonState = (base = daemonBase()): Promise<DaemonState> =>
  fetchMode(base).then(
    (mode): DaemonState => (mode.stopped ? 'stopped' : 'live'),
    (): DaemonState => 'offline',
  );

export async function untilState(
  want: (state: DaemonState) => boolean,
  probe: () => Promise<DaemonState>,
  pace: Pace,
): Promise<boolean> {
  const until = Date.now() + pace.maxMs;
  for (;;) {
    if (want(await probe())) return true;
    if (Date.now() >= until) return false;
    await wait(pace.everyMs);
  }
}

const paced = (maxMs: number): Pace => ({ everyMs: POLL_MS, maxMs });

export async function awaitLive(base = daemonBase()): Promise<void> {
  const up = await untilState((s) => s === 'live', () => daemonState(base), paced(UP_MAX_MS));
  if (!up) throw new Error(`metro did not come up on ${daemonHost(base)} yet. Check the machine.`);
}

export async function awaitStopped(base = daemonBase()): Promise<void> {
  const down = await untilState((s) => s === 'stopped', () => daemonState(base), paced(DOWN_MAX_MS));
  if (!down) throw new Error(`metro has not stopped on ${daemonHost(base)} yet. Check the machine.`);
}

export async function awaitRestart(base = daemonBase()): Promise<void> {
  await untilState((s) => s !== 'live', () => daemonState(base), paced(DOWN_MAX_MS));
  await awaitLive(base);
}
