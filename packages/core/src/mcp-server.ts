import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const MCP_SERVER_KEY = 'mcp';
export const MCP_TOKEN_FILE = 'mcp-token';
export const MCP_TOKEN_RE = /^mcp_[A-Za-z0-9_-]{43}$/;

const DEFAULT_URL = 'https://mcp.metro.box';
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

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

export const mcpServerSetting = (env: NodeJS.ProcessEnv = process.env): string => env.METRO_MCP_SERVER_URL?.trim() ?? DEFAULT_URL;

export function mcpServerUrlOf(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = mcpServerSetting(env);
  return raw !== '' && usable(raw) ? raw.replace(/\/+$/, '') : null;
}

export function readMcpToken(dir: string): string | null {
  let text: string;
  try {
    text = readFileSync(join(dir, MCP_TOKEN_FILE), 'utf8').trim();
  } catch {
    return null;
  }
  return MCP_TOKEN_RE.test(text) ? text : null;
}
