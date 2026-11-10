import { errMsg, log } from '@metro-labs/core/log';
import type { AgentKey } from '../connectors/agent-key.js';
import { MetroApiRefusal } from '../connectors/metro-api.js';

export const refusedWith = (err: unknown, status: number): boolean => err instanceof MetroApiRefusal && err.upstreamStatus === status;

export const backoff = (timing: { retryMs: number; retryMaxMs: number }, attempt: number): number => Math.min(timing.retryMs * 2 ** Math.min(attempt - 1, 20), timing.retryMaxMs);

export function enrolledKey(key: () => AgentKey | null, owner: () => string | null): AgentKey | null {
  try {
    const held = key();
    const organization = owner();
    return held !== null && organization !== null && held.enrollment?.organization === organization ? held : null;
  } catch (err) {
    log.warn({ err: errMsg(err) }, 'mcp-server: the agent key could not be read');
    return null;
  }
}

export function pause(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    timer.unref();
    signal.addEventListener('abort', done, { once: true });
  });
}
