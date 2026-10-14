import { log } from '@metro-labs/core/log';

export const MCP_SERVER_KEY = 'mcp';

const DEFAULT_URL = 'https://mcp.metro.box';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

let refused: string | undefined;

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

export function mcpServerUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.METRO_MCP_SERVER_URL?.trim() ?? DEFAULT_URL;
  if (raw === '') return null;
  if (usable(raw)) return raw.replace(/\/+$/, '');
  if (refused !== raw) {
    refused = raw;
    log.warn({ url: raw }, 'mcp-server: METRO_MCP_SERVER_URL must be an https url (http only on this machine), so it is ignored');
  }
  return null;
}
