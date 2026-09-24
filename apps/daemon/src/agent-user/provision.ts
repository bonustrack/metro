import { spawn, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { errMsg, log } from '@metro-labs/core/log';
import { isRecord } from '@metro-labs/core/is-record';
import { agentsDir } from '../agents/files.js';
import { copyIntoHome } from './home-fs.js';
import { agentMarketplaceDir, agentUser, asUser, claudeBin, forgetAgentUser, wantedAgentUser, type AgentUser } from './user.js';
import { watchAgentView } from './view.js';

const INSTALL_MS = 10 * 60_000;
const INSTALLER = 'curl -fsSL https://claude.ai/install.sh | bash';
const MIGRATED = '.agent-user-migrated';

export type Provisioned = 'off' | 'unsupported' | 'failed' | 'ready';

function run(file: string, args: string[]): void {
  const done = spawnSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (done.error !== undefined) throw done.error;
  if (done.status !== 0) throw new Error(`${file} ${args.join(' ')}: ${done.stderr.trim() || `exit ${String(done.status)}`}`);
}

function ensureUser(name: string): AgentUser | null {
  if (agentUser() === null) {
    run('useradd', ['--create-home', '--shell', '/bin/bash', name]);
    log.info({ user: name }, 'agent-user: created the user Claude Code runs as');
    forgetAgentUser();
  }
  const user = agentUser();
  if (user !== null) run('chmod', ['700', user.home]);
  return user;
}

const absent = (path: string): boolean => {
  try {
    lstatSync(path);
    return false;
  } catch {
    return true;
  }
};

const encodedCwd = (dir: string): string => dir.replace(/[^A-Za-z0-9]/g, '-');

function moveProject(user: AgentUser, from: string): void {
  const projects = join(user.home, '.claude', 'projects');
  const old = join(projects, encodedCwd(from));
  const next = join(projects, encodedCwd(user.home));
  if (existsSync(old) && absent(next)) run('mv', ['-T', old, next]);
}

function migrateClaude(user: AgentUser, dir: string): void {
  const marker = join(dir, MIGRATED);
  if (existsSync(marker)) return;
  const home = homedir();
  const copied: string[] = [];
  for (const name of ['.claude', '.claude.json']) {
    const from = join(home, name);
    const to = join(user.home, name);
    if (!existsSync(from) || !absent(to)) continue;
    run('cp', ['-aT', from, to]);
    run('chown', ['-hR', `${user.name}:${String(user.gid)}`, to]);
    copied.push(name);
  }
  if (copied.includes('.claude')) moveProject(user, home);
  run('touch', [marker]);
  log.info({ user: user.name, copied }, 'agent-user: moved the Claude Code folder and login to the agent user once; root keeps its copy');
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

function stopRootSession(): void {
  const running = spawnSync('tmux', ['has-session', '-t', 'metro'], { stdio: 'ignore' });
  if (running.error !== undefined || running.status !== 0) return;
  spawnSync('tmux', ['kill-session', '-t', 'metro'], { stdio: 'ignore' });
  log.info('agent-user: stopped the Claude session root was running; it comes back as the agent user');
}

export async function provisionAgentUser(dir = agentsDir(), env: NodeJS.ProcessEnv = process.env): Promise<Provisioned> {
  const name = wantedAgentUser(dir);
  if (name === null) return 'off';
  if (process.platform !== 'linux' || process.getuid?.() !== 0) {
    log.warn({ user: name }, 'agent-user: running Claude Code as its own user needs Linux and a daemon running as root; the Claude session stays stopped');
    return 'unsupported';
  }
  try {
    const user = ensureUser(name);
    if (user === null) throw new Error(`the user ${name} could not be found after creating it`);
    stopRootSession();
    migrateClaude(user, dir);
    await installClaude(user);
    copyMarketplace(user, env);
    watchAgentView();
    return 'ready';
  } catch (err) {
    log.error({ user: name, err: errMsg(err) }, 'agent-user: could not prepare the agent user; the Claude session stays stopped');
    return 'failed';
  }
}
