import { spawnSync } from 'node:child_process';
import { errMsg } from '@metro-labs/core/log';
import { asAgent } from '../agent-user/user.js';

export const CLAUDE_CODE_VERSION = '2.1.289';

const INSTALL_TIMEOUT_MS = 5 * 60_000;
const TAIL = 400;

export function installClaudeCode(bin: string): void {
  const run = spawnSync(...asAgent(bin, ['install', CLAUDE_CODE_VERSION]), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: INSTALL_TIMEOUT_MS });
  const failed = `claude install ${CLAUDE_CODE_VERSION} failed`;
  if (run.error !== undefined) throw new Error(`${failed}: ${errMsg(run.error)}`);
  if (run.status === 0) return;
  throw new Error(`${failed}: ${`${run.stderr}${run.stdout}`.trim().slice(-TAIL)}`);
}
