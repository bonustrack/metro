import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { metroMcpConfig, writeMcpConfig } from '../src/mcp-config.ts';

describe('the metro MCP server handed to Claude Code at launch', () => {
  test('is the local daemon over http, authenticated with the agent key in a header', () => {
    expect(JSON.parse(metroMcpConfig('mk_agent', 8420))).toEqual({
      mcpServers: {
        metro: {
          type: 'http',
          url: 'http://127.0.0.1:8420/mcp',
          headers: { Authorization: 'Bearer mk_agent' },
        },
      },
    });
    expect(metroMcpConfig('mk_agent', 9000)).toContain('http://127.0.0.1:9000/mcp');
  });

  test('is written to a private file for the session and removed afterwards', () => {
    const base = mkdtempSync(join(tmpdir(), 'metro-mcp-config-'));
    try {
      const file = writeMcpConfig('mk_agent', 8420, base);
      expect(dirname(dirname(file.path))).toBe(base);
      expect(statSync(file.path).mode & 0o777).toBe(0o600);
      expect(statSync(dirname(file.path)).mode & 0o777).toBe(0o700);
      expect(readFileSync(file.path, 'utf8')).toContain('Bearer mk_agent');
      file.cleanup();
      expect(existsSync(dirname(file.path))).toBe(false);
      file.cleanup();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
