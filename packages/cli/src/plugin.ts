import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { MARKETPLACE, runtimeStore } from './runtime-install.js';

const MARKETPLACE_REPO = 'bonustrack/metro';
const MARKETPLACE_NAME = 'metro';
const PLUGIN_SPEC = 'metro@metro';

export function marketplaceSource(store = runtimeStore()): string {
  const bundled = join(store, MARKETPLACE);
  return existsSync(join(bundled, '.claude-plugin', 'marketplace.json')) ? bundled : MARKETPLACE_REPO;
}

const realish = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

export function registeredMarketplacePath(listJson: string): string | null | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(listJson);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) return undefined;
  const mine = parsed.find((m: unknown) => typeof m === 'object' && m !== null && (m as { name?: unknown }).name === MARKETPLACE_NAME) as
    | { installLocation?: unknown; path?: unknown }
    | undefined;
  if (mine === undefined) return undefined;
  const at = mine.installLocation ?? mine.path;
  return typeof at === 'string' ? at : null;
}

export function installPathFrom(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const plugins = (parsed as { plugins?: unknown }).plugins;
  if (typeof plugins !== 'object' || plugins === null) return null;
  const entries = (plugins as Record<string, unknown>)[PLUGIN_SPEC];
  if (!Array.isArray(entries)) return null;
  const first = entries[0] as { installPath?: unknown } | undefined;
  return typeof first?.installPath === 'string' ? first.installPath : null;
}

export function pluginInstallPath(): string | null {
  const registry = join(homedir(), '.claude', 'plugins', 'installed_plugins.json');
  let raw: string;
  try {
    raw = readFileSync(registry, 'utf8');
  } catch {
    return null;
  }
  const path = installPathFrom(raw);
  if (path === null) return null;
  return existsSync(join(path, 'bin', 'metro-plugin.mjs')) ? path : null;
}

interface RunResult {
  ok: boolean;
  output: string;
}

function runClaude(args: string[]): RunResult {
  const res = spawnSync('claude', args, { encoding: 'utf8' });
  if (res.error !== undefined)
    throw new Error(
      'the `claude` command is not on PATH — install Claude Code first',
    );
  const output = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  return { ok: res.status === 0, output };
}

const tolerable = (output: string): boolean =>
  /already|exists|latest version/i.test(output);

export function syncPluginServers(): boolean {
  const path = pluginInstallPath();
  if (path === null) return false;
  const script = join(path, 'bin', 'metro-plugin.mjs');
  const refreshed = spawnSync(process.execPath, [script, 'refresh'], {
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  if (refreshed.status !== 0) return false;
  runClaude(['plugin', 'update', PLUGIN_SPEC]);
  return true;
}

function ensureMarketplace(source: string): RunResult {
  const listed = runClaude(['plugin', 'marketplace', 'list', '--json']);
  const at = registeredMarketplacePath(listed.output);
  if (at !== undefined && at !== null && (at === source || realish(at) === realish(source))) return { ok: true, output: '' };
  if (at !== undefined) runClaude(['plugin', 'marketplace', 'remove', MARKETPLACE_NAME]);
  return runClaude(['plugin', 'marketplace', 'add', source]);
}

export async function installPlugin(): Promise<number> {
  const source = marketplaceSource();
  const added = ensureMarketplace(source);
  if (!added.ok && !tolerable(added.output)) {
    process.stderr.write(added.output);
    return 1;
  }
  const installed = runClaude(['plugin', 'install', PLUGIN_SPEC, '-y', '--scope', 'user']);
  if (!installed.ok && !tolerable(installed.output)) {
    process.stderr.write(installed.output);
    return 1;
  }
  process.stderr.write(`Claude Code plugin installed from ${source}.\n`);
  if (syncPluginServers()) {
    process.stderr.write(
      'Connector servers loaded — new Claude sessions have them; ' +
        'run /reload-plugins --force in any session already open.\n',
    );
    return 0;
  }
  process.stderr.write(
    'Start the daemon on this machine (metro serve), then run /metro:refresh inside Claude Code.\n',
  );
  return Promise.resolve(0);
}
