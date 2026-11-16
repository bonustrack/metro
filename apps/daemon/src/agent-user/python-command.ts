import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { errMsg, log } from '@metro-labs/core/log';
import { writeHomeText } from './home-fs.js';
import { agentUser, asUser, type AgentUser } from './user.js';

export const PYTHON3 = '/usr/bin/python3';

export const PYTHON_PRESENT = 'command -v python >/dev/null 2>&1 || [ -e "$1" ] || [ -L "$1" ]';

export const pythonShim = (python3: string): string => `#!/bin/sh\nexec ${python3} "$@"\n`;

export type PythonCommand = 'written' | 'present' | 'skipped';

function present(user: AgentUser, target: string): boolean {
  const [file, argv] = asUser(user, 'sh', ['-c', PYTHON_PRESENT, 'metro', target]);
  const run = spawnSync(file, argv, { encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'], cwd: '/' });
  if (run.error !== undefined) throw run.error;
  if (run.status === 0) return true;
  if (run.status === 1) return false;
  throw new Error(`as ${user.name}: ${run.stderr.trim() || `exit ${String(run.status)}`}`);
}

export function placePythonCommand(user: AgentUser | null = agentUser(), python3 = PYTHON3): PythonCommand {
  if (user === null || !existsSync(python3)) return 'skipped';
  const target = join(user.home, '.local', 'bin', 'python');
  if (present(user, target)) return 'present';
  writeHomeText(target, pythonShim(python3), 0o755, undefined, user);
  return 'written';
}

export function tryPythonCommand(): void {
  try {
    if (placePythonCommand() === 'written') log.info({ python3: PYTHON3 }, 'agent-user: added a python command for the agent, which runs python3');
  } catch (err) {
    log.warn({ err: errMsg(err) }, 'agent-user: could not add a python command for the agent');
  }
}
