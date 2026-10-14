import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isRecord } from '@metro-labs/core/is-record';
import { errMsg, log } from '@metro-labs/core/log';
import { existsSync } from '../agent-user/agent-fs.js';
import { removeHome } from '../agent-user/home-fs.js';
import { agentUser, asAgent, claudeBin } from '../agent-user/user.js';
import { agentsDir } from '../agents/files.js';
import { readSetupState, writeSetupState } from './setup-state.js';

const PLUGIN = 'metro@metro';
const MARKETPLACE = 'metro';
const DONE = 'pluginRemoved';
const STEP_MS = 60_000;
const SAID_MAX = 300;

export interface Answer {
  status: number;
  stdout: string;
  stderr: string;
}

export type Run = (args: string[]) => Promise<Answer>;

export interface CleanupDeps {
  run?: Run | null;
  agents?: string;
  leftover?: string | null;
}

export type CleanupOutcome = 'done' | 'clean' | 'removed' | 'skipped' | 'failed';

export const claudeAt =
  (bin: string): Run =>
  (args) =>
    new Promise((resolve) => {
      execFile(...asAgent(bin, args), { encoding: 'utf8', timeout: STEP_MS, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
        const code = (err as { code?: unknown } | null)?.code;
        resolve({ status: err === null ? 0 : typeof code === 'number' ? code : 1, stdout, stderr });
      });
    });

async function findClaude(): Promise<Run | null> {
  const candidates = agentUser() === null ? ['claude', join(homedir(), '.local', 'bin', 'claude')] : [claudeBin()];
  for (const bin of candidates) {
    const run = claudeAt(bin);
    if ((await run(['--version'])).status === 0) return run;
  }
  return null;
}

function listOf(stdout: string): Record<string, unknown>[] {
  try {
    const parsed: unknown = JSON.parse(stdout);
    return Array.isArray(parsed) ? parsed.filter(isRecord) : [];
  } catch {
    return [];
  }
}

async function listed(run: Run, args: string[], key: string, wanted: string): Promise<boolean | null> {
  const answer = await run(args);
  if (answer.status !== 0) {
    log.warn({ args, said: `${answer.stderr}${answer.stdout}`.trim().slice(0, SAID_MAX) }, 'claude-plugin: claude could not list');
    return null;
  }
  return listOf(answer.stdout).some((entry) => entry[key] === wanted);
}

async function step(run: Run, args: string[]): Promise<boolean> {
  const answer = await run(args);
  if (answer.status === 0) {
    log.info({ args }, 'claude-plugin: removed what the old metro plugin left');
    return true;
  }
  log.warn({ args, said: `${answer.stderr}${answer.stdout}`.trim().slice(0, SAID_MAX) }, 'claude-plugin: claude refused');
  return false;
}

async function removeIfListed(run: Run, list: string[], key: string, wanted: string, remove: string[]): Promise<'gone' | 'removed' | 'failed'> {
  const present = await listed(run, list, key, wanted);
  if (present === null) return 'failed';
  if (!present) return 'gone';
  return (await step(run, remove)) ? 'removed' : 'failed';
}

function leftoverDir(): string | null {
  const user = agentUser();
  return user === null ? null : join(user.home, '.metro', 'marketplace');
}

function removeLeftover(dir: string | null): boolean {
  if (dir === null || !existsSync(dir)) return true;
  try {
    removeHome(dir, true);
    log.info({ dir }, 'claude-plugin: removed the old plugin marketplace copy');
    return true;
  } catch (err) {
    log.warn({ dir, err: errMsg(err) }, 'claude-plugin: could not remove the old plugin marketplace copy');
    return false;
  }
}

async function cleanUp(run: Run, leftover: string | null): Promise<'removed' | 'clean' | 'failed'> {
  const plugin = await removeIfListed(run, ['plugin', 'list', '--json'], 'id', PLUGIN, ['plugin', 'uninstall', PLUGIN]);
  const market = await removeIfListed(run, ['plugin', 'marketplace', 'list', '--json'], 'name', MARKETPLACE, ['plugin', 'marketplace', 'remove', MARKETPLACE]);
  const folder = removeLeftover(leftover);
  if (plugin === 'failed' || market === 'failed' || !folder) return 'failed';
  return plugin === 'removed' || market === 'removed' ? 'removed' : 'clean';
}

export async function removeMetroPlugin(deps: CleanupDeps = {}): Promise<CleanupOutcome> {
  const agents = deps.agents ?? agentsDir();
  if (readSetupState(agents)[DONE] === true) return 'done';
  const run = deps.run === undefined ? await findClaude() : deps.run;
  if (run === null) return 'skipped';
  const outcome = await cleanUp(run, deps.leftover === undefined ? leftoverDir() : deps.leftover);
  if (outcome !== 'failed') writeSetupState(agents, { [DONE]: true });
  return outcome;
}
