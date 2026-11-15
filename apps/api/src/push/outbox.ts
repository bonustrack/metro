import { log } from '@metro-labs/core/log';
import type { Database } from '@metro-labs/connectors/db/database';
import { failureText, isNotMigrated } from '@metro-labs/connectors/db/errors';
import { claimPushes, prunePushes, PUSH_ATTEMPTS_MAX, releasePush, type QueuedPush } from '@metro-labs/connectors/db/push-outbox';
import type { PushOutcome, PushSender } from './sender.js';

export const OUTBOX_TICK_MS = 3000;
export const OUTBOX_CLAIM_MAX = 20;
export const RETRY_MS = [3000, 15_000, 60_000, 300_000];

const PRUNE_EVERY_MS = 60 * 60_000;

export interface OutboxDeps {
  db: () => Database;
  sender: Pick<PushSender, 'notify'>;
  now: () => number;
}

const reached = (outcome: PushOutcome): boolean => outcome.sent > 0 || outcome.failed === 0;

const retryDelay = (attempts: number): number => RETRY_MS[Math.min(attempts, RETRY_MS.length) - 1] ?? OUTBOX_TICK_MS;

async function deliver(deps: OutboxDeps, row: QueuedPush): Promise<void> {
  const context = { owner: row.owner, agent: row.agent, approval: row.approval, attempt: row.attempts };
  try {
    const outcome = await deps.sender.notify(row.owner, { title: row.title, body: row.body, url: row.url });
    if (reached(outcome)) {
      log.info({ ...context, ...outcome }, 'push: notification sent');
      return;
    }
    log.warn({ ...context, ...outcome }, 'push: no device took the notification');
  } catch (err) {
    log.warn({ ...context, err: failureText(err) }, 'push: notification not sent');
  }
  await releasePush(deps.db(), row.id, deps.now() + retryDelay(row.attempts));
  if (row.attempts >= PUSH_ATTEMPTS_MAX) log.warn(context, 'push: notification given up');
}

export async function runOutbox(deps: OutboxDeps): Promise<number> {
  const rows = await claimPushes(deps.db(), deps.now(), OUTBOX_CLAIM_MAX);
  for (const row of rows) await deliver(deps, row);
  return rows.length;
}

export async function pruneOutbox(deps: Pick<OutboxDeps, 'db' | 'now'>): Promise<number> {
  const removed = await prunePushes(deps.db(), deps.now());
  if (removed > 0) log.info({ removed }, 'push: old notifications removed');
  return removed;
}

export function startPushOutbox(deps: OutboxDeps): () => void {
  let busy = false;
  let quiet = false;
  let prunedAt = Number.NEGATIVE_INFINITY;
  const failed = (err: unknown): void => {
    if (quiet) return;
    quiet = true;
    if (isNotMigrated(err)) log.warn('push: the push_outbox table is not migrated yet, so notifications wait');
    else log.warn({ err: failureText(err) }, 'push: the outbox could not be read, later failures stay quiet until it works');
  };
  const tick = async (): Promise<void> => {
    if (deps.now() - prunedAt >= PRUNE_EVERY_MS) {
      prunedAt = deps.now();
      await pruneOutbox(deps);
    }
    await runOutbox(deps);
    quiet = false;
  };
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    tick()
      .catch(failed)
      .finally(() => {
        busy = false;
      });
  }, OUTBOX_TICK_MS);
  timer.unref();
  return () => {
    clearInterval(timer);
  };
}
