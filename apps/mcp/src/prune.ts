import { errMsg, log } from '@metro-labs/core/log';
import type { Database } from '@metro-labs/connectors/db/database';
import { pruneApprovals } from '@metro-labs/connectors/db/mcp-approvals';
import { expireMail, pruneInbox } from '@metro-labs/connectors/db/connector-inbox';
import type { McpDeps } from './deps.js';
import { recordQuietly } from './mail.js';

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

type MailDeps = Pick<McpDeps, 'key' | 'inbox' | 'calls' | 'waiters' | 'now'>;

export async function pruneMailOnce(db: () => Database, deps: MailDeps): Promise<number | null> {
  try {
    const now = deps.now();
    const expired = await expireMail(db(), now);
    for (const row of expired) recordQuietly(deps, row, 'expired', now - row.receivedAt);
    const removed = await pruneInbox(db(), now);
    log.info({ expired: expired.length, removed }, 'mcp: expired mail no box took in 7 days and removed old inbox rows');
    return expired.length + removed;
  } catch (err) {
    log.warn({ err: errMsg(err) }, 'mcp: could not expire old mail');
    return null;
  }
}

export function startMailPruning(db: () => Database, deps: MailDeps, everyMs = PRUNE_EVERY_MS): () => void {
  const run = (): void => {
    pruneMailOnce(db, deps).catch((err: unknown) => {
      log.warn({ err: errMsg(err) }, 'mcp: could not expire old mail');
    });
  };
  run();
  const timer = setInterval(run, everyMs);
  timer.unref();
  return () => {
    clearInterval(timer);
  };
}
