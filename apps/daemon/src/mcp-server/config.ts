import { log } from '@metro-labs/core/log';
import { mcpServerSetting, mcpServerUrlOf } from '@metro-labs/core/mcp-server';

let refused: string | undefined;

export function mcpServerUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const url = mcpServerUrlOf(env);
  const raw = mcpServerSetting(env);
  if (url === null && raw !== '' && refused !== raw) {
    refused = raw;
    log.warn({ url: raw }, 'mcp-server: METRO_MCP_SERVER_URL must be an https url (http only on this machine), so it is ignored');
  }
  return url;
}
