import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const METRO_SERVER = 'metro';
const CONNECTORS_SERVER = 'mcp';
const CHAT_PATH = '/mcp';
export const VOICE_MCP_PATH = '/mcp/voice';
const DEFAULT_MCP_SERVER_URL = 'https://mcp.metro.box';
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
const UNSAFE_PATH = /["$`\\\n]/;

export const MCP_HEADERS_HELPER = join(dirname(dirname(fileURLToPath(import.meta.url))), 'hooks', 'mcp-headers.mjs');

function usable(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  const secure = url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK.has(url.hostname));
  return secure && url.username === '' && url.password === '' && url.search === '' && url.hash === '';
}

export const mcpServerSetting = (env: NodeJS.ProcessEnv = process.env): string => env.METRO_MCP_SERVER_URL?.trim() ?? DEFAULT_MCP_SERVER_URL;

export function mcpServerUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = mcpServerSetting(env);
  return raw !== '' && usable(raw) ? raw.replace(/\/+$/, '') : null;
}

interface HttpServer {
  type: 'http';
  url: string;
  headers?: Record<string, string>;
  headersHelper?: string;
}

export interface McpConfigOptions {
  key: string | null;
  port: number;
  path?: string;
  connectors?: string | null;
  helper?: string;
}

function servers(opts: McpConfigOptions): Record<string, HttpServer> {
  const out: Record<string, HttpServer> = {};
  if (opts.key !== null)
    out[METRO_SERVER] = { type: 'http', url: `http://127.0.0.1:${String(opts.port)}${opts.path ?? CHAT_PATH}`, headers: { Authorization: `Bearer ${opts.key}` } };
  const connectors = opts.connectors === undefined ? mcpServerUrl() : opts.connectors;
  const helper = opts.helper ?? MCP_HEADERS_HELPER;
  if (connectors !== null && !UNSAFE_PATH.test(helper)) out[CONNECTORS_SERVER] = { type: 'http', url: connectors, headersHelper: `node "${helper}"` };
  return out;
}

const configText = (found: Record<string, HttpServer>): string | null =>
  Object.keys(found).length === 0 ? null : `${JSON.stringify({ mcpServers: found }, null, 2)}\n`;

export const metroMcpConfig = (opts: McpConfigOptions): string | null => configText(servers(opts));

export interface McpConfigFile {
  path: string;
  servers: string[];
  cleanup: () => void;
}

export function writeMcpConfig(opts: McpConfigOptions, base = tmpdir()): McpConfigFile | null {
  const found = servers(opts);
  const text = configText(found);
  if (text === null) return null;
  const dir = mkdtempSync(join(base, 'metro-claude-'));
  const path = join(dir, 'mcp.json');
  writeFileSync(path, text, { mode: 0o600 });
  return {
    path,
    servers: Object.keys(found),
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
