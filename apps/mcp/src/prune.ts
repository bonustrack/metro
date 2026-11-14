import { errMsg, log } from '@metro-labs/core/log';
import { pruneEvents } from '@metro-labs/connectors/db/connector-events';
import type { Database } from '@metro-labs/connectors/db/database';
import { failureText, isNotMigrated } from '@metro-labs/connectors/db/errors';
import { pruneApprovals } from '@metro-labs/connectors/db/mcp-approvals';
import type { McpDeps } from './deps.js';
import { recordEvent } from './events.js';

const PRUNE_EVERY_MS = 60 * 60_000;

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

type EventPruneDeps = Pick<McpDeps, 'events' | 'calls' | 'now'>;

export async function pruneEventsOnce(deps: EventPruneDeps, db: () => Database): Promise<{ expired: number; removed: number } | null> {
  try {
    const { expired, removed } = await pruneEvents(db(), deps.now());
    for (const row of expired) recordEvent(deps, row, 'expired', 0);
    if (removed > 0) log.info({ expired: expired.length, removed }, 'mcp: removed connector events older than 7 days; those no agent took are recorded as expired');
    return { expired: expired.length, removed };
  } catch (err) {
    if (isNotMigrated(err)) log.info('mcp: the connector event tables are not migrated yet, so there is nothing to expire');
    else log.warn({ err: failureText(err) }, 'mcp: could not expire old connector events');
    return null;
  }
}

export function startEventPruning(deps: EventPruneDeps, db: () => Database, everyMs = PRUNE_EVERY_MS): () => void {
  const run = (): void => {
    pruneEventsOnce(deps, db).catch((err: unknown) => {
      log.warn({ err: failureText(err) }, 'mcp: could not expire old connector events');
    });
  };
  run();
  const timer = setInterval(run, everyMs);
  timer.unref();
  return () => {
    clearInterval(timer);
  };
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
