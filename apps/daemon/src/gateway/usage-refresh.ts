import { errMsg, log } from '@metro-labs/core/log';
import { openrouterKey } from './openrouter.js';
import { mayProbe, noteUsage, openrouterUsage, usageOf } from './usage.js';
import type { Connection, ModelSetup } from './model-config.js';

export const CREDITS_TTL_MS = 5 * 60_000;
const WAIT_MS = 4_000;

export interface UsageDeps {
  fetchImpl?: typeof fetch;
  openrouterBase?: string;
  usageWaitMs?: number;
}

const fresh = (id: string, now: number): boolean => {
  const seen = usageOf(id);
  return seen !== undefined && now - Date.parse(seen.at) < CREDITS_TTL_MS;
};

async function refreshKey(conn: Connection, deps: UsageDeps, now: number): Promise<void> {
  if (conn.provider !== 'openrouter' || conn.apiKey === '' || fresh(conn.id, now) || !mayProbe(conn.id, now, CREDITS_TTL_MS)) return;
  try {
    noteUsage(conn.id, openrouterUsage(await openrouterKey(conn.apiKey, deps.openrouterBase, deps.fetchImpl), new Date(now)));
  } catch (err) {
    log.warn({ err: errMsg(err) }, 'model-api: could not read the OpenRouter key spend');
  }
}

async function within(ms: number, work: Promise<unknown>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const waited = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  await Promise.race([work, waited]);
  clearTimeout(timer);
}

export async function refreshUsage(setup: ModelSetup, deps: UsageDeps = {}, now = Date.now()): Promise<void> {
  await within(deps.usageWaitMs ?? WAIT_MS, Promise.all(setup.connections.map((conn) => refreshKey(conn, deps, now))));
}

export function watchFallbackUsage(setup: () => ModelSetup, deps: UsageDeps = {}, every = CREDITS_TTL_MS): void {
  const run = (): void => {
    const current = setup();
    if (current.fallbacks.length === 0) return;
    refreshUsage(current, deps).catch((err: unknown) => {
      log.warn({ err: errMsg(err) }, 'model-api: could not refresh the usage of the fallback models');
    });
  };
  setInterval(run, every).unref();
}
