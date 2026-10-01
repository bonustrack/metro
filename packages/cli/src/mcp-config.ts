import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const METRO_SERVER = 'metro';
const CHAT_PATH = '/mcp';
export const VOICE_MCP_PATH = '/mcp/voice';

export function metroMcpConfig(agentKey: string, port: number, path = CHAT_PATH): string {
  const servers = {
    [METRO_SERVER]: {
      type: 'http',
      url: `http://127.0.0.1:${String(port)}${path}`,
      headers: { Authorization: `Bearer ${agentKey}` },
    },
  };
  return `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`;
}

export interface McpConfigFile {
  path: string;
  cleanup: () => void;
}

export function writeMcpConfig(agentKey: string, port: number, base = tmpdir(), mcpPath = CHAT_PATH): McpConfigFile {
  const dir = mkdtempSync(join(base, 'metro-claude-'));
  const path = join(dir, 'mcp.json');
  writeFileSync(path, metroMcpConfig(agentKey, port, mcpPath), { mode: 0o600 });
  return {
    path,
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
