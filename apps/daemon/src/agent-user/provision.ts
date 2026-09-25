import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { errMsg, log } from '@metro-labs/core/log';
import { isRecord } from '@metro-labs/core/is-record';
import { copyIntoHome } from './home-fs.js';
import { AGENT_NAME, agentMarketplaceDir, agentUser, agentUserExpected, asUser, claudeBin, forgetAgentUser, type AgentUser } from './user.js';
import { watchAgentView } from './view.js';

const INSTALL_MS = 10 * 60_000;
const INSTALLER = 'curl -fsSL https://claude.ai/install.sh | bash';

export type Provisioned = 'off' | 'failed' | 'ready';

function run(file: string, args: string[]): void {
  const done = spawnSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (done.error !== undefined) throw done.error;
  if (done.status !== 0) throw new Error(`${file} ${args.join(' ')}: ${done.stderr.trim() || `exit ${String(done.status)}`}`);
}

function ensureUser(): AgentUser | null {
  if (agentUser() === null) {
    run('useradd', ['--create-home', '--shell', '/bin/bash', AGENT_NAME]);
    log.info({ user: AGENT_NAME }, 'agent-user: created the user Claude Code runs as');
    forgetAgentUser();
  }
  const user = agentUser();
  if (user !== null) run('chmod', ['700', user.home]);
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

const pluginVersion = (dir: string): string | null => {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dir, 'plugin', '.claude-plugin', 'plugin.json'), 'utf8'));
    return isRecord(parsed) && typeof parsed.version === 'string' ? parsed.version : null;
  } catch {
    return null;
  }
};

function copyMarketplace(user: AgentUser, env: NodeJS.ProcessEnv): void {
  const store = env.METRO_RUNTIME_STORE?.trim() ?? '';
  const from = join(store, 'marketplace');
  if (store === '' || !existsSync(join(from, '.claude-plugin', 'marketplace.json'))) return;
  const to = agentMarketplaceDir(user);
  if (pluginVersion(from) !== null && pluginVersion(from) === pluginVersion(to)) return;
  const files = copyIntoHome(from, to, user);
  log.info({ files, version: pluginVersion(from) }, 'agent-user: copied the metro plugin where the agent user can load it');
}

export async function provisionAgentUser(env: NodeJS.ProcessEnv = process.env): Promise<Provisioned> {
  if (!agentUserExpected()) return 'off';
  try {
    const user = ensureUser();
    if (user === null) throw new Error(`the user ${AGENT_NAME} could not be found after creating it`);
    await installClaude(user);
    copyMarketplace(user, env);
    watchAgentView();
    return 'ready';
  } catch (err) {
    log.error({ user: AGENT_NAME, err: errMsg(err) }, 'agent-user: could not prepare the agent user; the Claude session stays stopped');
    return 'failed';
  }
}
