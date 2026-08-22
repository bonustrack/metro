import { randomBytes } from 'node:crypto';
import type { OAuthClient } from './oauth-client.js';
import type { OAuthServer } from './oauth-discovery.js';

const TTL_MS = 10 * 60_000;
const SWEEP_MS = 60_000;
const MAX_PENDING = 100;

export interface PendingAuth {
  email: string;
  name: string;
  url: string;
  resource: string;
  returnTo: string;
  verifier: string;
  server: OAuthServer;
  client: OAuthClient;
  connectorId: string;
}

interface Entry extends PendingAuth {
  expiresAt: number;
}

const pending = new Map<string, Entry>();
let sweeper: ReturnType<typeof setInterval> | null = null;

function sweep(now = Date.now()): void {
  for (const [state, entry] of pending)
    if (entry.expiresAt <= now) pending.delete(state);
}

function ensureSweeper(): void {
  if (sweeper !== null) return;
  sweeper = setInterval(sweep, SWEEP_MS);
  sweeper.unref?.();
}

export function startPending(entry: PendingAuth, now = Date.now()): string {
  sweep(now);
  while (pending.size >= MAX_PENDING) {
    const oldest = pending.keys().next();
    if (oldest.done) break;
    pending.delete(oldest.value);
  }
  const state = randomBytes(32).toString('base64url');
  pending.set(state, { ...entry, expiresAt: now + TTL_MS });
  ensureSweeper();
  return state;
}

export function takePending(
  state: string,
  now = Date.now(),
): PendingAuth | undefined {
  const entry = pending.get(state);
  if (entry === undefined) return undefined;
  pending.delete(state);
  return entry.expiresAt > now ? entry : undefined;
}

export function pendingCount(): number {
  sweep();
  return pending.size;
}
