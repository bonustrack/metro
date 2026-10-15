import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { errMsg, log } from '@metro-labs/core/log';
import { AGENT_NAME, agentUser, agentUserExpected, asUser, forgetAgentUser, type AgentUser } from './user.js';
import { watchAgentView } from './view.js';
import { closeMetroHome } from './metro-home.js';
import { mustHelper } from '../metro-user/privilege.js';
import { prepareRunnerStore } from '../claude/session.js';

export type Provisioned = 'off' | 'failed' | 'ready';

function run(file: string, args: string[]): void {
  const done = spawnSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (done.error !== undefined) throw done.error;
  if (done.status !== 0) throw new Error(`${file} ${args.join(' ')}: ${done.stderr.trim() || `exit ${String(done.status)}`}`);
}

function openMetroHome(): void {
  closeMetroHome();
  chmodSync(join(homedir(), '.metro'), 0o700);
}

function ensureUser(): AgentUser | null {
  mustHelper(['ensure-agent']);
  openMetroHome();
  forgetAgentUser();
  const user = agentUser();
  if (user !== null) {
    run(...asUser(user, 'chmod', ['711', user.home]));
    run(...asUser(user, 'sh', ['-c', 'test ! -d "$1" || chmod go-w "$1"', 'sh', join(user.home, '.metro')]));
  }
  return user;
}

export function provisionAgentUser(): Provisioned {
  if (!agentUserExpected()) return 'off';
  try {
    const user = ensureUser();
    if (user === null) throw new Error(`the user ${AGENT_NAME} could not be found after creating it`);
    watchAgentView();
    return 'ready';
  } catch (err) {
    log.error({ user: AGENT_NAME, err: errMsg(err) }, 'agent-user: could not prepare the agent user; the Claude session stays stopped');
    return 'failed';
  }
}

export async function prepareAgentRunner(): Promise<void> {
  try {
    await prepareRunnerStore();
    log.info('agent-user: the Agent SDK runner and the Claude Code it bundles are ready for the agent user');
  } catch (err) {
    log.error({ err: errMsg(err) }, 'agent-user: could not prepare the Agent SDK runner; the session start runs metro agent, which prepares it again');
  }
}
