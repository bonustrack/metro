import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { writeHomeInPlace } from '../agent-user/home-fs.js';
import { agentMarketplaceDir, agentUser } from '../agent-user/user.js';
import { join } from 'node:path';
import { errMsg, log } from '@metro-labs/core/log';
import { claudeDir } from '../claude/files.js';
import { loopbackBase } from '../files/attach-serve.js';

const MARKER = join('bin', 'metro-plugin.mjs');
const FILE = '.mcp.json';
const HELPER = 'node "${CLAUDE_PLUGIN_ROOT}/bin/metro-plugin.mjs" headers';
const SLUG_MAX = 40;

export interface PluginRow {
  id: string;
  name: string;
}

export interface PluginServer {
  type: 'http';
  url: string;
  headersHelper: string;
}

export function serverKey(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX)
    .replace(/-+$/, '');
  return slug === '' ? 'connector' : slug;
}

export function serverKeysOf(rows: PluginRow[]): Map<string, string> {
  const taken = new Map<string, number>();
  const keys = new Map<string, string>();
  for (const row of rows) {
    const wanted = serverKey(row.name);
    const seen = taken.get(wanted) ?? 0;
    taken.set(wanted, seen + 1);
    keys.set(row.id, seen === 0 ? wanted : `${wanted}-${row.id.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 4)}`);
  }
  return keys;
}

export function pluginServers(rows: PluginRow[], base: string): Record<string, PluginServer> {
  const out: Record<string, PluginServer> = {};
  for (const [id, key] of serverKeysOf(rows)) out[key] = { type: 'http', url: `${base}/relay/${id}`, headersHelper: HELPER };
  return out;
}

const SEARCH_DEPTH = 5;

function pluginRootsUnder(dir: string, depth: number, out: string[]): void {
  if (depth < 0 || out.length >= 8) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  if (entries.some((e) => e.name === 'bin' && e.isDirectory()) && existsSync(join(dir, MARKER))) {
    out.push(dir);
    return;
  }
  for (const entry of entries)
    if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules')
      pluginRootsUnder(join(dir, entry.name), depth - 1, out);
}

export function stagedPluginDir(env: NodeJS.ProcessEnv = process.env): string | null {
  const store = env.METRO_RUNTIME_STORE?.trim() ?? '';
  if (store === '') return null;
  const user = agentUser();
  return join(user === null ? join(store, 'marketplace') : agentMarketplaceDir(user), 'plugin');
}

export function installedPluginFiles(dir = claudeDir(), staged = stagedPluginDir()): string[] {
  const roots: string[] = [];
  const root = join(dir, 'plugins');
  if (existsSync(root)) pluginRootsUnder(root, SEARCH_DEPTH, roots);
  if (staged !== null && existsSync(join(staged, MARKER)) && !roots.includes(staged)) roots.push(staged);
  return roots.map((found) => join(found, FILE));
}

const readOrNull = (path: string): string | null => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
};

function writeIfChanged(path: string, text: string): boolean {
  if (readOrNull(path) === text) return false;
  writeHomeInPlace(path, text, 0o644);
  return true;
}

export interface PluginSyncOptions {
  dir?: string;
  base?: string;
  staged?: string | null;
}

function filesFor(opts: PluginSyncOptions): string[] {
  const staged = opts.staged === undefined ? stagedPluginDir() : opts.staged;
  return installedPluginFiles(opts.dir ?? claudeDir(), staged);
}

export function syncPluginServers(rows: PluginRow[], opts: PluginSyncOptions = {}): number {
  const files = filesFor(opts);
  if (files.length === 0) return 0;
  const servers = pluginServers(rows, opts.base ?? loopbackBase());
  const text = `${JSON.stringify(servers, null, 2)}\n`;
  let written = 0;
  for (const file of files) {
    try {
      if (writeIfChanged(file, text)) written += 1;
    } catch (err) {
      log.warn({ file, err: errMsg(err) }, 'plugin: could not write the connector servers');
    }
  }
  if (written > 0)
    log.info(
      { files: written, servers: Object.keys(servers).length },
      'plugin: connector servers written; run /reload-plugins --force to pick them up in a running session',
    );
  return written;
}
