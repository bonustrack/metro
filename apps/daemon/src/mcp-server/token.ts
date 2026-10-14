import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isRecord } from '@metro-labs/core/is-record';
import { writeSecure } from '@metro-labs/core/secure-fs';
import { MCP_TOKEN_RE } from '@metro-labs/http/mcp-server-protocol';

export const MCP_TOKEN_FILE = 'mcp-token';
const BINDING_FILE = 'mcp-token.json';

export interface McpToken {
  token: string;
  hash: string;
  fresh: boolean;
}

export const mcpTokenHash = (token: string): string => createHash('sha256').update(token).digest('base64url');

const readText = (path: string): string | null => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
};

export function readMcpToken(dir: string): string | null {
  const text = readText(join(dir, MCP_TOKEN_FILE))?.trim() ?? '';
  return MCP_TOKEN_RE.test(text) ? text : null;
}

function boundKeyId(dir: string): string | null {
  const text = readText(join(dir, BINDING_FILE));
  if (text === null) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) && parsed.version === 1 && typeof parsed.keyId === 'string' ? parsed.keyId : null;
  } catch {
    return null;
  }
}

export function ensureMcpToken(keyId: string, dir: string): McpToken {
  const kept = readMcpToken(dir);
  if (kept !== null && boundKeyId(dir) === keyId) return { token: kept, hash: mcpTokenHash(kept), fresh: false };
  const token = `mcp_${randomBytes(32).toString('base64url')}`;
  writeSecure(join(dir, MCP_TOKEN_FILE), `${token}\n`);
  writeSecure(join(dir, BINDING_FILE), `${JSON.stringify({ version: 1, keyId })}\n`);
  return { token, hash: mcpTokenHash(token), fresh: true };
}
