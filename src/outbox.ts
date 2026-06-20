import {
  appendFileSync,
  existsSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { errMsg, log } from './log.js';
import { STATE_DIR } from './paths.js';

export const OUTBOX_FILE = join(STATE_DIR, 'outbox.jsonl');

export const RETRY_BACKOFFS_MS = [2_000, 10_000, 30_000] as const;
export const MAX_ATTEMPTS = RETRY_BACKOFFS_MS.length;

export type OutboxState = 'pending' | 'sent' | 'failed' | 'dead';

export type ErrorInfo = { retryable?: boolean } & Record<string, unknown>;

export interface OutboxEntry {
  outboxId: string;
  idempotencyKey: string;
  train: string;
  action: string;
  args: unknown;
  state: OutboxState;
  attempts: number;
  ts: string;
  updatedAt?: string;
  lastError?: string;
}

export const mintIdempotencyKey = (): string => `idem_${randomUUID()}`;

export function isRetryable(
  error: string | undefined,
  info: ErrorInfo | undefined,
): boolean {
  if (info?.retryable === false) return false;
  if (info?.retryable === true) return true;
  const e = (error ?? '').toLowerCase();
  if (!e) return true;
  return !/invalid|unsupported|not found|no such|unauthor|forbidden|bad request|malformed|rejected/.test(
    e,
  );
}

export class Outbox {
  private entries = new Map<string, OutboxEntry>();
  private loaded = false;

  constructor(private readonly file: string = OUTBOX_FILE) {}

  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (!existsSync(this.file)) return;
    let raw: string;
    try {
      raw = readFileSync(this.file, 'utf8');
    } catch (err) {
      log.warn(
        { err: errMsg(err), file: this.file },
        'outbox: read failed; starting empty',
      );
      return;
    }
    for (const line of raw.split('\n')) {
      const s = line.trim();
      if (!s) continue;
      try {
        const e = JSON.parse(s) as OutboxEntry;
        if (e && typeof e.outboxId === 'string')
          this.entries.set(e.outboxId, e);
      } catch (err) {
        log.warn(
          { err: errMsg(err), line: s.slice(0, 120) },
          'outbox: bad JSONL line; skipped',
        );
      }
    }
  }

  private append(e: OutboxEntry): void {
    try {
      appendFileSync(this.file, JSON.stringify(e) + '\n');
    } catch (err) {
      log.warn(
        { err: errMsg(err), file: this.file },
        'outbox: append failed (entry not durable)',
      );
    }
  }

  enqueue(
    idempotencyKey: string,
    train: string,
    action: string,
    args: unknown,
  ): OutboxEntry {
    this.ensureLoaded();
    const now = new Date().toISOString();
    const e: OutboxEntry = {
      outboxId: `out_${randomUUID()}`,
      idempotencyKey,
      train,
      action,
      args,
      state: 'pending',
      attempts: 0,
      ts: now,
    };
    this.entries.set(e.outboxId, e);
    this.append(e);
    return e;
  }

  markAttempt(outboxId: string): void {
    const e = this.entries.get(outboxId);
    if (!e) return;
    e.attempts += 1;
    e.updatedAt = new Date().toISOString();
    this.append(e);
  }

  markSent(outboxId: string): void {
    this.transition(outboxId, 'sent');
  }

  markFailed(
    outboxId: string,
    error: string | undefined,
    info?: ErrorInfo,
  ): number | null {
    const e = this.entries.get(outboxId);
    if (!e) return null;
    e.lastError = error ?? 'unknown error';
    const retryable = isRetryable(error, info);
    if (!retryable || e.attempts >= MAX_ATTEMPTS) {
      this.transition(outboxId, 'dead');
      return null;
    }
    this.transition(outboxId, 'failed');
    const idx = Math.min(e.attempts - 1, RETRY_BACKOFFS_MS.length - 1);
    return RETRY_BACKOFFS_MS[Math.max(0, idx)];
  }

  requeue(outboxId: string): OutboxEntry | null {
    this.ensureLoaded();
    const e = this.entries.get(outboxId);
    if (!e) return null;
    e.state = 'pending';
    e.attempts = 0;
    e.lastError = undefined;
    e.updatedAt = new Date().toISOString();
    this.append(e);
    return e;
  }

  private transition(outboxId: string, state: OutboxState): void {
    const e = this.entries.get(outboxId);
    if (!e) return;
    e.state = state;
    e.updatedAt = new Date().toISOString();
    this.append(e);
  }

  get(outboxId: string): OutboxEntry | undefined {
    this.ensureLoaded();
    return this.entries.get(outboxId);
  }

  list(opts: { state?: OutboxState; limit?: number } = {}): OutboxEntry[] {
    this.ensureLoaded();
    let out = [...this.entries.values()];
    if (opts.state) out = out.filter((e) => e.state === opts.state);
    out.sort((a, b) => b.ts.localeCompare(a.ts));
    if (opts.limit && opts.limit > 0) out = out.slice(0, opts.limit);
    return out;
  }

  pendingForReplay(): OutboxEntry[] {
    this.ensureLoaded();
    return [...this.entries.values()].filter(
      (e) => e.state === 'pending' && e.attempts === 0,
    );
  }

  compact(): void {
    this.ensureLoaded();
    const tmp = `${this.file}.tmp`;
    try {
      const body = [...this.entries.values()]
        .map((e) => JSON.stringify(e))
        .join('\n');
      writeFileSync(tmp, body ? body + '\n' : '');
      renameSync(tmp, this.file);
    } catch (err) {
      log.warn(
        { err: errMsg(err), file: this.file },
        'outbox: compaction failed',
      );
    }
  }
}
