import { errMsg, log } from './log.js';
import type { LoadedAgent, StationSource } from '../db/materialize.js';

const POLL_MS = 30_000;
const BACKOFF_MS = 5 * 60_000;
const FETCH_TIMEOUT_MS = 15_000;

export class RuntimeRevoked extends Error {}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

export function carriesSecretsSafely(base: string): boolean {
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    return false;
  }
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && LOOPBACK.has(url.hostname);
}

export interface RuntimeConfig {
  url: string;
  token: string;
}

export function runtimeConfigFromEnv(): RuntimeConfig | null {
  const token = process.env.METRO_RUN_TOKEN?.trim() ?? '';
  if (token === '') return null;
  const raw = (process.env.METRO_URL?.trim() ?? '').replace(/\/+$/, '');
  const url = raw === '' ? 'https://mcp.metro.box' : raw;
  if (!carriesSecretsSafely(url))
    throw new Error(
      `refusing to fetch station credentials from ${url} in the clear — ` +
        'use https, or a loopback address',
    );
  return { url, token };
}

export function httpSource(cfg: RuntimeConfig): StationSource {
  return async () => {
    const res = await fetch(`${cfg.url}/api/run/config`, {
      headers: { authorization: `Bearer ${cfg.token}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: 'manual',
    });
    if (res.status === 401 || res.status === 403 || res.status === 409)
      throw new RuntimeRevoked(
        `metro no longer recognises this machine as the holder (${String(res.status)})`,
      );
    if (!res.ok)
      throw new Error(`metro answered ${String(res.status)} for the run config`);
    const body = (await res.json()) as { agent?: LoadedAgent };
    if (!body.agent) throw new Error('metro returned no agent');
    return [body.agent];
  };
}

export interface PollerDeps {
  sync: () => Promise<void>;
  stopAll: () => Promise<void>;
  everyMs?: number;
  backoffMs?: number;
}

export function startRuntimePoller(deps: PollerDeps): () => void {
  const everyMs = deps.everyMs ?? POLL_MS;
  const backoffMs = deps.backoffMs ?? BACKOFF_MS;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const arm = (ms: number): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      tick().catch((err: unknown) => {
        log.error({ err: errMsg(err) }, 'runtime: poller failed');
      });
    }, ms);
    timer.unref?.();
  };

  async function tick(): Promise<void> {
    if (stopped) return;
    try {
      await deps.sync();
      arm(everyMs);
    } catch (err) {
      if (err instanceof RuntimeRevoked) {
        stopped = true;
        log.error({ reason: err.message }, 'runtime: revoked — stopping stations');
        await deps.stopAll();
        return;
      }
      log.warn({ err: errMsg(err) }, 'runtime: could not reach metro; retrying');
      arm(backoffMs);
    }
  }

  arm(everyMs);
  return () => {
    stopped = true;
    if (timer !== null) clearTimeout(timer);
  };
}
