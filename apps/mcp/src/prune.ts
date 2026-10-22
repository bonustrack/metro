import { errMsg, log } from '@metro-labs/core/log';
import type { Database } from '@metro-labs/connectors/db/database';
import { pruneApprovals } from '@metro-labs/connectors/db/mcp-approvals';

export const PRUNE_EVERY_MS = 60 * 60_000;

export async function pruneOnce(db: () => Database, now: () => number): Promise<number | null> {
  try {
    const removed = await pruneApprovals(db(), now());
    log.info({ removed }, 'mcp: removed answered approvals older than 7 days');
    return removed;
  } catch (err) {
    log.warn({ err: errMsg(err) }, 'mcp: could not remove old approvals');
    return null;
  }
}

export function startApprovalPruning(db: () => Database, now: () => number = Date.now, everyMs = PRUNE_EVERY_MS): () => void {
  const run = (): void => {
    pruneOnce(db, now).catch((err: unknown) => {
      log.warn({ err: errMsg(err) }, 'mcp: could not remove old approvals');
    });
  };
  run();
  const timer = setInterval(run, everyMs);
  timer.unref();
  return () => {
    clearInterval(timer);
  };
}
