import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MCP_TOKEN_RE, mcpServerSetting, mcpServerUrlOf, readMcpToken } from '../src/mcp-server.ts';

describe('the mcp.metro.box url every process shares', () => {
  test('is mcp.metro.box unless METRO_MCP_SERVER_URL names an https url, or http on this machine; empty turns it off', () => {
    expect(mcpServerUrlOf({})).toBe('https://mcp.metro.box');
    expect(mcpServerUrlOf({ METRO_MCP_SERVER_URL: 'https://mcp.metro.box/' })).toBe('https://mcp.metro.box');
    expect(mcpServerUrlOf({ METRO_MCP_SERVER_URL: ' http://localhost:18430// ' })).toBe('http://localhost:18430');
    for (const off of ['', ' ', 'http://mcp.metro.box', 'https://user:pw@mcp.metro.box', 'https://mcp.metro.box/?a=1', 'https://mcp.metro.box/#x', 'mcp.metro.box', 'ftp://x'])
      expect(mcpServerUrlOf({ METRO_MCP_SERVER_URL: off })).toBeNull();
    expect(mcpServerSetting({})).toBe('https://mcp.metro.box');
    expect(mcpServerSetting({ METRO_MCP_SERVER_URL: ' ' })).toBe('');
  });

  test('the token is read from the agents folder only when it has the token shape', () => {
    const dir = mkdtempSync(join(tmpdir(), 'metro-core-mcp-'));
    try {
      expect(readMcpToken(dir)).toBeNull();
      const token = `mcp_${'k'.repeat(43)}`;
      writeFileSync(join(dir, 'mcp-token'), `${token}\n`);
      expect(readMcpToken(dir)).toBe(token);
      expect(MCP_TOKEN_RE.test(token)).toBe(true);
      writeFileSync(join(dir, 'mcp-token'), 'mcp_short\n');
      expect(readMcpToken(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
