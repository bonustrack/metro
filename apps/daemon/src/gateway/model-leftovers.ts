import { lstatSync, readdirSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { errMsg, log } from '@metro-labs/core/log';
import { agentsDir } from '../agents/files.js';
import { existsSync } from '../agent-user/agent-fs.js';
import { removeHome } from '../agent-user/home-fs.js';
import { agentUser, agentUserExpected } from '../agent-user/user.js';

const LEFTOVER_RE = /^(?:chatgpt-host|model)\.json(?:\.tmp-[0-9]+)?$/;

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

export function claudeLoginsDir(): string | null {
  const user = agentUser();
  if (user === null && agentUserExpected()) return null;
  return join(user?.home ?? homedir(), '.metro', 'claude-logins');
}

function removeClaudeLogins(dir: string | null): number {
  if (dir === null || !existsSync(dir)) return 0;
  try {
    removeHome(dir, true);
    return 1;
  } catch (err) {
    log.warn({ err: errMsg(err), dir }, 'org-models: could not remove the folder of the old Claude logins');
    return 0;
  }
}

export function removeModelLeftovers(dir = agentsDir(), logins: string | null = claudeLoginsDir()): number {
  try {
    const removed = namesIn(dir).filter((name) => removeOne(join(dir, name))).length + removeClaudeLogins(logins);
    log.info({ removed }, 'org-models: removed the files of the old model setup');
    return removed;
  } catch (err) {
    log.warn({ err: errMsg(err) }, 'org-models: could not remove the files of the old model setup');
    return 0;
  }
}
