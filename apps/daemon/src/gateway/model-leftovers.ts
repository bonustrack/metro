import { lstatSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { errMsg, log } from '@metro-labs/core/log';
import { agentsDir } from '../agents/files.js';

const LEFTOVER_RE = /^chatgpt-host\.json(?:\.tmp-[0-9]+)?$/;

const codeOf = (err: unknown): unknown => (err instanceof Error && 'code' in err ? err.code : undefined);

function namesIn(dir: string): string[] {
  try {
    return readdirSync(dir).filter((name) => LEFTOVER_RE.test(name));
  } catch (err) {
    if (codeOf(err) !== 'ENOENT') log.warn({ err: errMsg(err), dir }, 'org-models: could not list the old model files');
    return [];
  }
}

function removeOne(path: string): boolean {
  try {
    if (!lstatSync(path).isFile()) {
      log.warn({ path }, 'org-models: left an old model file alone, it is not a regular file');
      return false;
    }
    unlinkSync(path);
    return true;
  } catch (err) {
    if (codeOf(err) !== 'ENOENT') log.warn({ err: errMsg(err), path }, 'org-models: could not remove an old model file');
    return false;
  }
}

export function removeModelLeftovers(dir = agentsDir()): number {
  try {
    const removed = namesIn(dir).filter((name) => removeOne(join(dir, name))).length;
    log.info({ removed }, 'org-models: removed the files of the old model setup');
    return removed;
  } catch (err) {
    log.warn({ err: errMsg(err) }, 'org-models: could not remove the files of the old model setup');
    return 0;
  }
}
