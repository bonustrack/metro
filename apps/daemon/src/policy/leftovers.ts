import { lstatSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { errMsg, log } from '@metro-labs/core/log';
import { agentsDir } from '../agents/files.js';

export const POLICY_SNAPSHOT_FILE = 'policy.json';

const LEFTOVER_RE = /^policy\.json(?:\.tmp-[0-9]+)?$/;

const codeOf = (err: unknown): unknown => (err instanceof Error && 'code' in err ? err.code : undefined);

function namesIn(dir: string): string[] {
  try {
    return readdirSync(dir).filter((name) => LEFTOVER_RE.test(name));
  } catch (err) {
    if (codeOf(err) !== 'ENOENT') log.warn({ err: errMsg(err), dir }, 'policy: could not list the old rules snapshot');
    return [];
  }
}

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

export function removePolicyLeftovers(dir = agentsDir()): number {
  try {
    const removed = namesIn(dir).filter((name) => removeOne(join(dir, name))).length;
    log.info({ removed }, 'policy: removed the rules snapshot the guard hook used to read');
    return removed;
  } catch (err) {
    log.warn({ err: errMsg(err) }, 'policy: could not remove the old rules snapshot');
    return 0;
  }
}
