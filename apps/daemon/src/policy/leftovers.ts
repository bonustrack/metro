import { lstatSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { errMsg, log } from '@metro-labs/core/log';
import { agentsDir } from '../agents/files.js';

const SNAPSHOT_RE = /^policy\.json(?:\.tmp-[0-9]+)?$/;

const codeOf = (err: unknown): unknown => (err instanceof Error && 'code' in err ? err.code : undefined);

function removeOne(path: string): boolean {
  try {
    if (!lstatSync(path).isFile()) {
      log.warn({ path }, 'policy: left an old rules snapshot alone, it is not a regular file');
      return false;
    }
    unlinkSync(path);
    return true;
  } catch (err) {
    if (codeOf(err) !== 'ENOENT') log.warn({ err: errMsg(err), path }, 'policy: could not remove the old rules snapshot');
    return false;
  }
}

export function removePolicySnapshot(dir = agentsDir()): number {
  try {
    const removed = readdirSync(dir).filter((name) => SNAPSHOT_RE.test(name) && removeOne(join(dir, name))).length;
    if (removed > 0) log.info({ removed }, 'policy: removed the rules snapshot the guard hook used to read');
    return removed;
  } catch (err) {
    if (codeOf(err) !== 'ENOENT') log.warn({ err: errMsg(err), dir }, 'policy: could not look for the old rules snapshot');
    return 0;
  }
}
