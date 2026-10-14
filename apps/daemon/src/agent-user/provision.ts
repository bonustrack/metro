import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from './agent-fs.js';
import { join } from 'node:path';
import { chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { errMsg, log } from '@metro-labs/core/log';
import { AGENT_NAME, agentUser, agentUserExpected, asUser, claudeBin, forgetAgentUser, type AgentUser } from './user.js';
import { watchAgentView } from './view.js';
import { closeMetroHome } from './metro-home.js';
import { mustHelper } from '../metro-user/privilege.js';
import { CLAUDE_CODE_VERSION } from '../claude/pinned.js';
import { pinClaudeCode } from '../claude/version.js';

const INSTALL_MS = 10 * 60_000;
const INSTALLER = `curl -fsSL https://claude.ai/install.sh | bash -s ${CLAUDE_CODE_VERSION}`;

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

function installClaude(user: AgentUser): Promise<void> {
  if (existsSync(claudeBin(user))) return Promise.resolve();
  const [file, args] = asUser(user, 'bash', ['-c', INSTALLER]);
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: ['ignore', 'ignore', 'pipe'], cwd: '/', timeout: INSTALL_MS });
    let said = '';
    child.stderr.on('data', (chunk: Buffer) => {
      said = `${said}${chunk.toString('utf8')}`.slice(-2000);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0 && existsSync(claudeBin(user))) {
        log.info({ user: user.name }, 'agent-user: installed Claude Code for the agent user');
        resolve();
      } else reject(new Error(`the Claude Code installer failed: ${said.trim() || `exit ${String(code)}`}`));
    });
  });
}

function pinCheckedClaude(): void {
  try {
    pinClaudeCode();
  } catch (err) {
    log.warn({ want: CLAUDE_CODE_VERSION, err: errMsg(err) }, 'agent-user: could not install the Claude Code version metro was checked with; keeping the installed one');
  }
}

export async function provisionAgentUser(): Promise<Provisioned> {
  if (!agentUserExpected()) return 'off';
  try {
    const user = ensureUser();
    if (user === null) throw new Error(`the user ${AGENT_NAME} could not be found after creating it`);
    await installClaude(user);
    pinCheckedClaude();
    watchAgentView();
    return 'ready';
  } catch (err) {
    log.error({ user: AGENT_NAME, err: errMsg(err) }, 'agent-user: could not prepare the agent user; the Claude session stays stopped');
    return 'failed';
  }
}
