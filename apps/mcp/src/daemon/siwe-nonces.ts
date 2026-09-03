import { generateSiweNonce } from 'viem/siwe';

const TTL_MS = 10 * 60_000;
const SWEEP_MS = 60_000;
const MAX_LIVE = 500;

const live = new Map<string, number>();
let sweeper: ReturnType<typeof setInterval> | null = null;

function sweep(now = Date.now()): void {
  for (const [nonce, expiresAt] of live) if (expiresAt <= now) live.delete(nonce);
}

function ensureSweeper(): void {
  if (sweeper !== null) return;
  sweeper = setInterval(sweep, SWEEP_MS);
  sweeper.unref?.();
}

export function mintNonce(now = Date.now()): string {
  sweep(now);
  while (live.size >= MAX_LIVE) {
    const oldest = live.keys().next();
    if (oldest.done) break;
    live.delete(oldest.value);
  }
  const nonce = generateSiweNonce();
  live.set(nonce, now + TTL_MS);
  ensureSweeper();
  return nonce;
}

export function takeNonce(nonce: string, now = Date.now()): boolean {
  const expiresAt = live.get(nonce);
  if (expiresAt === undefined) return false;
  live.delete(nonce);
  return expiresAt > now;
}

export function nonceCount(): number {
  sweep();
  return live.size;
}
