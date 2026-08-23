import { randomBytes } from 'node:crypto';

const TTL_MS = 10 * 60_000;
const SWEEP_MS = 60_000;
const MAX_CODES = 100;

export interface CodeStore<T> {
  pattern: RegExp;
  mint(entry: T, now?: number): { code: string; expiresAt: number };
  take(code: string, now?: number): T | undefined;
  count(): number;
}

export function makeCodeStore<T extends object>(prefix: string): CodeStore<T> {
  const codes = new Map<string, T & { expiresAt: number }>();
  let sweeper: ReturnType<typeof setInterval> | null = null;

  const sweep = (now = Date.now()): void => {
    for (const [code, entry] of codes)
      if (entry.expiresAt <= now) codes.delete(code);
  };

  const ensureSweeper = (): void => {
    if (sweeper !== null) return;
    sweeper = setInterval(sweep, SWEEP_MS);
    sweeper.unref?.();
  };

  return {
    pattern: new RegExp(`^${prefix}_[A-Za-z0-9_-]{16}$`),
    mint(entry, now = Date.now()) {
      sweep(now);
      while (codes.size >= MAX_CODES) {
        const oldest = codes.keys().next();
        if (oldest.done) break;
        codes.delete(oldest.value);
      }
      const code = `${prefix}_${randomBytes(12).toString('base64url')}`;
      const expiresAt = now + TTL_MS;
      codes.set(code, { ...entry, expiresAt });
      ensureSweeper();
      return { code, expiresAt };
    },
    take(code, now = Date.now()) {
      const entry = codes.get(code);
      if (entry === undefined) return undefined;
      codes.delete(code);
      if (entry.expiresAt <= now) return undefined;
      const rest: Record<string, unknown> = { ...entry };
      delete rest.expiresAt;
      return rest as T;
    },
    count() {
      sweep();
      return codes.size;
    },
  };
}
