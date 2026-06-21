import { errMsg, log } from './log.js';
import { mutateVerbs, type VerbOwner } from './registry.js';
import { Outbox, type ErrorInfo, type OutboxEntry } from './outbox.js';
import type { TrainCallResponse } from './trains/protocol.js';

export type CallFn = (
  train: string,
  action: string,
  args: unknown,
) => Promise<TrainCallResponse>;

const VERB_OWNERS: readonly VerbOwner[] = [
  'xmtp',
  'discord',
  'telegram',
  'core',
];
const isOwner = (t: string): t is VerbOwner =>
  (VERB_OWNERS as readonly string[]).includes(t);

export function isMutateCall(train: string, action: string): boolean {
  if (!isOwner(train)) return false;
  return mutateVerbs(train).has(action);
}

function errorInfoOf(resp: TrainCallResponse): ErrorInfo | undefined {
  const info = (resp as { errorInfo?: unknown }).errorInfo;
  return info && typeof info === 'object' ? (info as ErrorInfo) : undefined;
}

export class OutboxDriver {
  private timers = new Set<ReturnType<typeof setTimeout>>();

  constructor(
    private readonly call: CallFn,
    private readonly outbox = new Outbox(),
  ) {}

  async forward(
    train: string,
    action: string,
    args: unknown,
    idempotencyKey?: string,
  ): Promise<TrainCallResponse> {
    if (!isMutateCall(train, action)) return this.call(train, action, args);
    const key = idempotencyKey ?? `idem_${train}_${action}_${Date.now()}`;
    const entry = this.outbox.enqueue(key, train, action, args);
    return this.attempt(entry);
  }

  private async attempt(entry: OutboxEntry): Promise<TrainCallResponse> {
    this.outbox.markAttempt(entry.outboxId);
    try {
      const resp = await this.call(entry.train, entry.action, entry.args);
      if (resp.error) {
        this.onFailure(entry, resp.error, errorInfoOf(resp));
        return resp;
      }
      this.outbox.markSent(entry.outboxId);
      return resp;
    } catch (err) {
      this.onFailure(entry, errMsg(err), undefined);
      throw err;
    }
  }

  private onFailure(entry: OutboxEntry, error: string, info?: ErrorInfo): void {
    const backoff = this.outbox.markFailed(entry.outboxId, error, info);
    if (backoff === null) {
      log.warn(
        {
          outboxId: entry.outboxId,
          train: entry.train,
          action: entry.action,
          error,
        },
        'outbox: dead letter (no more retries) — see `metro outbox --state dead`',
      );
      return;
    }
    log.info(
      {
        outboxId: entry.outboxId,
        train: entry.train,
        action: entry.action,
        backoff,
        error,
      },
      'outbox: retry scheduled',
    );
    this.scheduleRetry(entry, backoff);
  }

  private scheduleRetry(entry: OutboxEntry, delay: number): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      void this.attempt(entry).catch(() => undefined);
    }, delay);
    this.timers.add(timer);
  }

  recover(): void {
    const replay = this.outbox.pendingForReplay();
    if (!replay.length) return;
    log.info(
      { count: replay.length },
      'outbox: replaying never-dispatched entries after restart',
    );
    for (const e of replay)
      void this.attempt(e).catch(() => undefined);
  }

  retry(outboxId: string): boolean {
    const e = this.outbox.requeue(outboxId);
    if (!e) return false;
    void this.attempt(e).catch(() => undefined);
    return true;
  }

  list(opts: Parameters<Outbox['list']>[0] = {}): OutboxEntry[] {
    return this.outbox.list(opts);
  }

  stop(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }
}
