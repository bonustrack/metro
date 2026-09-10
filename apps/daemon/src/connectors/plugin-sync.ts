import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { errMsg, log } from '@metro-labs/core/log';
import { claudeDir } from '../claude/files.js';
import { loopbackBase } from '../files/attach-serve.js';
import { readLocalConnectors, type LocalConnectorRow } from './store.js';

const MARKER = join('bin', 'metro-plugin.mjs');
const FILE = '.mcp.json';
const HELPER = 'node "${CLAUDE_PLUGIN_ROOT}/bin/metro-plugin.mjs" headers';
const SLUG_MAX = 40;

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

export function pluginServers(rows: LocalConnectorRow[], base: string): Record<string, PluginServer> {
  const taken = new Map<string, number>();
  const out: Record<string, PluginServer> = {};
  for (const row of rows) {
    const wanted = serverKey(row.name);
    const seen = taken.get(wanted) ?? 0;
    taken.set(wanted, seen + 1);
    const key = seen === 0 ? wanted : `${wanted}-${row.id.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 4)}`;
    out[key] = { type: 'http', url: `${base}/relay/${row.id}`, headersHelper: HELPER };
  }
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

export function installedPluginFiles(dir = claudeDir()): string[] {
  const root = join(dir, 'plugins');
  if (!existsSync(root)) return [];
  const roots: string[] = [];
  pluginRootsUnder(root, SEARCH_DEPTH, roots);
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
  writeFileSync(path, text, { mode: 0o644 });
  return true;
}

export interface PluginSyncOptions {
  dir?: string;
  base?: string;
  agents?: string;
}

export function syncPluginServers(opts: PluginSyncOptions = {}): number {
  const files = installedPluginFiles(opts.dir ?? claudeDir());
  if (files.length === 0) return 0;
  const base = opts.base ?? loopbackBase();
  const rows = opts.agents === undefined ? readLocalConnectors() : readLocalConnectors(opts.agents);
  const servers = pluginServers(rows, base);
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
