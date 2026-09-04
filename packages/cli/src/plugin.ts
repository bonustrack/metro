import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readToken } from './store.js';

const MARKETPLACE_REPO = 'bonustrack/metro';
const PLUGIN_SPEC = 'metro@metro';

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
  if (path === null || readToken() === null) return false;
  const script = join(path, 'bin', 'metro-plugin.mjs');
  const refreshed = spawnSync(process.execPath, [script, 'refresh'], {
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  if (refreshed.status !== 0) return false;
  runClaude(['plugin', 'update', PLUGIN_SPEC]);
  return true;
}

export async function installPlugin(): Promise<number> {
  const added = runClaude(['plugin', 'marketplace', 'add', MARKETPLACE_REPO]);
  if (!added.ok && !tolerable(added.output)) {
    process.stderr.write(added.output);
    return 1;
  }
  const installed = runClaude(['plugin', 'install', PLUGIN_SPEC]);
  if (!installed.ok && !tolerable(installed.output)) {
    process.stderr.write(installed.output);
    return 1;
  }
  process.stderr.write('Claude Code plugin installed.\n');
  if (syncPluginServers()) {
    process.stderr.write(
      'Connector servers loaded — new Claude sessions have them; ' +
        'run /reload-plugins in any session already open.\n',
    );
    return 0;
  }
  process.stderr.write(
    'Now sign in: metro login (with a pairing code from https://metro.box), ' +
      'or run /metro:login <code> inside Claude Code.\n',
  );
  return Promise.resolve(0);
}
