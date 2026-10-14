import { existsSync, readdirEntries, readFileSync } from '../agent-user/agent-fs.js';
import { writeHomeInPlace } from '../agent-user/home-fs.js';
import { agentMarketplaceDir, agentUser } from '../agent-user/user.js';
import { join } from 'node:path';
import { errMsg, log } from '@metro-labs/core/log';
import { claudeDir } from '../claude/files.js';
import { MCP_SERVER_KEY, mcpServerUrl } from '../mcp-server/config.js';

const MARKER = join('bin', 'metro-plugin.mjs');
const FILE = '.mcp.json';
const MCP_HELPER = 'node "${CLAUDE_PLUGIN_ROOT}/bin/metro-plugin.mjs" mcp-headers';

interface PluginServer {
  type: 'http';
  url: string;
  headersHelper: string;
}

const pluginServers = (url: string | null): Record<string, PluginServer> =>
  url === null ? {} : { [MCP_SERVER_KEY]: { type: 'http', url, headersHelper: MCP_HELPER } };

const SEARCH_DEPTH = 5;

function pluginRootsUnder(dir: string, depth: number, out: string[]): void {
  if (depth < 0 || out.length >= 8) return;
  let entries;
  try {
    entries = readdirEntries(dir);
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

function stagedPluginDir(env: NodeJS.ProcessEnv = process.env): string | null {
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
  staged?: string | null;
  url?: string | null;
}

function filesFor(opts: PluginSyncOptions): string[] {
  const staged = opts.staged === undefined ? stagedPluginDir() : opts.staged;
  return installedPluginFiles(opts.dir ?? claudeDir(), staged);
}

export function syncPluginServers(opts: PluginSyncOptions = {}): number {
  const files = filesFor(opts);
  if (files.length === 0) return 0;
  const servers = pluginServers(opts.url === undefined ? mcpServerUrl() : opts.url);
  const text = `${JSON.stringify(servers, null, 2)}\n`;
  let written = 0;
  for (const file of files) {
    try {
      if (writeIfChanged(file, text)) written += 1;
    } catch (err) {
      log.warn({ file, err: errMsg(err) }, 'plugin: could not write the MCP servers');
    }
  }
  if (written > 0)
    log.info(
      { files: written, servers: Object.keys(servers) },
      'plugin: MCP servers written; run /reload-plugins --force to pick them up in a running session',
    );
  return written;
}
