import { execFile } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isRecord } from '@metro-labs/core/is-record';
import { log } from '@metro-labs/core/log';

const MARKETPLACE = 'metro';
const PLUGIN = 'metro@metro';
const STEP_MS = 120_000;
const SAID_MAX = 300;

export interface Answer {
  status: number;
  stdout: string;
  stderr: string;
}

export type Run = (args: string[]) => Promise<Answer>;

export interface PluginInstallDeps {
  run: Run | null;
  marketplaceDir: string | null;
}

export type PluginOutcome = 'skipped' | 'unchanged' | 'installed' | 'updated' | 'failed';

export function stagedMarketplaceDir(env: NodeJS.ProcessEnv = process.env): string | null {
  const store = env.METRO_RUNTIME_STORE?.trim() ?? '';
  if (store === '') return null;
  const dir = join(store, 'marketplace');
  return existsSync(join(dir, '.claude-plugin', 'marketplace.json')) ? dir : null;
}

export function stagedPluginVersion(dir: string): string | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dir, 'plugin', '.claude-plugin', 'plugin.json'), 'utf8'));
    return isRecord(parsed) && typeof parsed.version === 'string' ? parsed.version : null;
  } catch {
    return null;
  }
}

const runner =
  (bin: string): Run =>
  (args) =>
    new Promise((resolve) => {
      execFile(bin, args, { encoding: 'utf8', timeout: STEP_MS, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
        const status = err === null ? 0 : typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1;
        resolve({ status, stdout, stderr });
      });
    });

export async function findClaude(candidates = ['claude', join(homedir(), '.local', 'bin', 'claude')]): Promise<Run | null> {
  for (const bin of candidates) {
    const run = runner(bin);
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

const realish = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

const samePath = (a: string | null, b: string): boolean => a !== null && realish(a) === realish(b);

async function step(run: Run, args: string[]): Promise<boolean> {
  const answer = await run(args);
  if (answer.status === 0) {
    log.info({ args }, 'plugin: claude');
    return true;
  }
  log.warn({ args, said: `${answer.stderr}${answer.stdout}`.trim().slice(0, SAID_MAX) }, 'plugin: claude refused');
  return false;
}

async function marketplacePath(run: Run): Promise<string | null | undefined> {
  const mine = listOf((await run(['plugin', 'marketplace', 'list', '--json'])).stdout).find((m) => m.name === MARKETPLACE);
  if (mine === undefined) return undefined;
  const at = mine.installLocation ?? mine.path;
  return typeof at === 'string' ? at : null;
}

async function ensureMarketplace(run: Run, dir: string): Promise<boolean> {
  const at = await marketplacePath(run);
  if (at !== undefined && samePath(at, dir)) return true;
  if (at !== undefined) await step(run, ['plugin', 'marketplace', 'remove', MARKETPLACE]);
  return step(run, ['plugin', 'marketplace', 'add', dir]);
}

async function installedVersion(run: Run): Promise<string | null> {
  const mine = listOf((await run(['plugin', 'list', '--json'])).stdout).find((p) => p.id === PLUGIN);
  return mine !== undefined && typeof mine.version === 'string' ? mine.version : null;
}

async function ensureInstalled(run: Run, wanted: string | null): Promise<PluginOutcome> {
  const have = await installedVersion(run);
  if (have === null) return (await step(run, ['plugin', 'install', PLUGIN, '-y', '--scope', 'user'])) ? 'installed' : 'failed';
  if (wanted === null || have === wanted) return 'unchanged';
  await step(run, ['plugin', 'marketplace', 'update', MARKETPLACE]);
  return (await step(run, ['plugin', 'update', PLUGIN, '-y'])) ? 'updated' : 'failed';
}

export async function ensureMetroPlugin(deps?: Partial<PluginInstallDeps>): Promise<PluginOutcome> {
  const dir = deps?.marketplaceDir === undefined ? stagedMarketplaceDir() : deps.marketplaceDir;
  if (dir === null) return 'skipped';
  const run = deps?.run === undefined ? await findClaude() : deps.run;
  if (run === null) {
    log.info('plugin: claude is not on this machine, so metro leaves its Claude Code plugin alone');
    return 'skipped';
  }
  if (!(await ensureMarketplace(run, dir))) return 'failed';
  return ensureInstalled(run, stagedPluginVersion(dir));
}
