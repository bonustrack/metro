import { randomBytes } from 'node:crypto';

const TTL_MS = 10 * 60_000;
const SWEEP_MS = 60_000;
const MAX_CODES = 100;

export const CLI_CODE_RE = /^mc_[A-Za-z0-9_-]{16}$/;

export interface CliCode {
  email: string;
  collectionId: string;
}

interface Entry extends CliCode {
  expiresAt: number;
}

const codes = new Map<string, Entry>();
let sweeper: ReturnType<typeof setInterval> | null = null;

function sweep(now = Date.now()): void {
  for (const [code, entry] of codes) if (entry.expiresAt <= now) codes.delete(code);
}

function ensureSweeper(): void {
  if (sweeper !== null) return;
  sweeper = setInterval(sweep, SWEEP_MS);
  sweeper.unref?.();
}

export function mintCliCode(
  entry: CliCode,
  now = Date.now(),
): { code: string; expiresAt: number } {
  sweep(now);
  while (codes.size >= MAX_CODES) {
    const oldest = codes.keys().next();
    if (oldest.done) break;
    codes.delete(oldest.value);
  }
  const code = `mc_${randomBytes(12).toString('base64url')}`;
  const expiresAt = now + TTL_MS;
  codes.set(code, { ...entry, expiresAt });
  ensureSweeper();
  return { code, expiresAt };
}

export function takeCliCode(
  code: string,
  now = Date.now(),
): CliCode | undefined {
  const entry = codes.get(code);
  if (entry === undefined) return undefined;
  codes.delete(code);
  if (entry.expiresAt <= now) return undefined;
  return { email: entry.email, collectionId: entry.collectionId };
}

export function cliCodeCount(): number {
  sweep();
  return codes.size;
}
