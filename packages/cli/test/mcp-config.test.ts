import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { claudeArgs } from '../src/claude.ts';
import { MCP_HEADERS_HELPER, mcpServerUrl, metroMcpConfig, VOICE_MCP_PATH, writeMcpConfig } from '../src/mcp-config.ts';

const MCP = 'https://mcp.metro.box';
const TOKEN = `mcp_${'t'.repeat(43)}`;
const parsed = (text: string | null): unknown => JSON.parse(text ?? 'null');

describe('the MCP servers handed to Claude Code at launch', () => {
  test('metro is the local daemon over http, authenticated with the agent key in a header', () => {
    expect(parsed(metroMcpConfig({ key: 'mk_agent', port: 8420, connectors: null }))).toEqual({
      mcpServers: {
        metro: {
          type: 'http',
          url: 'http://127.0.0.1:8420/mcp',
          headers: { Authorization: 'Bearer mk_agent' },
        },
      },
    });
    expect(metroMcpConfig({ key: 'mk_agent', port: 9000, connectors: null })).toContain('http://127.0.0.1:9000/mcp');
    expect(metroMcpConfig({ key: 'mk_agent', port: 8420, path: VOICE_MCP_PATH, connectors: null })).toContain('"http://127.0.0.1:8420/mcp/voice"');
  });

  test('mcp is the connectors server, whose header comes from the helper the CLI ships, so no token is in the file', () => {
    expect(parsed(metroMcpConfig({ key: 'mk_agent', port: 8420, connectors: MCP }))).toEqual({
      mcpServers: {
        metro: { type: 'http', url: 'http://127.0.0.1:8420/mcp', headers: { Authorization: 'Bearer mk_agent' } },
        mcp: { type: 'http', url: MCP, headersHelper: `node "${MCP_HEADERS_HELPER}"` },
      },
    });
    expect(MCP_HEADERS_HELPER).toBe(join(import.meta.dir, '..', 'hooks', 'mcp-headers.mjs'));
    expect(existsSync(MCP_HEADERS_HELPER)).toBe(true);
    expect(parsed(metroMcpConfig({ key: null, port: 8420, connectors: MCP }))).toEqual({
      mcpServers: { mcp: { type: 'http', url: MCP, headersHelper: `node "${MCP_HEADERS_HELPER}"` } },
    });
    expect(metroMcpConfig({ key: null, port: 8420, connectors: null })).toBeNull();
    expect(metroMcpConfig({ key: null, port: 8420, connectors: MCP, helper: '/x/it"s/mcp-headers.mjs' })).toBeNull();
  });

  test('follows METRO_MCP_SERVER_URL with the daemon rule: mcp.metro.box by default, https or loopback http, empty is off', () => {
    expect(mcpServerUrl({})).toBe(MCP);
    expect(mcpServerUrl({ METRO_MCP_SERVER_URL: 'https://mcp.metro.box/' })).toBe(MCP);
    expect(mcpServerUrl({ METRO_MCP_SERVER_URL: 'http://127.0.0.1:18080' })).toBe('http://127.0.0.1:18080');
    for (const off of ['', ' ', 'http://mcp.metro.box', 'https://user:pw@mcp.metro.box', 'https://mcp.metro.box/?a=1', 'mcp.metro.box', 'ftp://x'])
      expect(mcpServerUrl({ METRO_MCP_SERVER_URL: off })).toBeNull();
    const before = process.env.METRO_MCP_SERVER_URL;
    process.env.METRO_MCP_SERVER_URL = '';
    try {
      expect(metroMcpConfig({ key: 'mk_agent', port: 8420 })).not.toContain('"mcp"');
    } finally {
      if (before === undefined) delete process.env.METRO_MCP_SERVER_URL;
      else process.env.METRO_MCP_SERVER_URL = before;
    }
  });

  test('is written to a private file for the session and removed afterwards, and only its path reaches the command line', () => {
    const base = mkdtempSync(join(tmpdir(), 'metro-mcp-config-'));
    const agents = join(base, 'agents');
    mkdirSync(agents);
    writeFileSync(join(agents, 'mcp-token'), `${TOKEN}\n`);
    const before = process.env.METRO_AGENTS_DIR;
    process.env.METRO_AGENTS_DIR = agents;
    try {
      const file = writeMcpConfig({ key: 'mk_agent', port: 8420, connectors: MCP }, base);
      if (file === null) throw new Error('no config file');
      expect(file.servers).toEqual(['metro', 'mcp']);
      expect(dirname(dirname(file.path))).toBe(base);
      expect(statSync(file.path).mode & 0o777).toBe(0o600);
      expect(statSync(dirname(file.path)).mode & 0o777).toBe(0o700);
      expect(readFileSync(file.path, 'utf8')).toContain('Bearer mk_agent');
      expect(readFileSync(file.path, 'utf8')).not.toContain(TOKEN);
      const argv = claudeArgs(['-c'], file.path, 'auto', null);
      expect(argv.slice(argv.indexOf('--mcp-config'), argv.indexOf('--mcp-config') + 2)).toEqual(['--mcp-config', file.path]);
      expect(argv.join(' ')).not.toContain(TOKEN);
      expect(argv.join(' ')).not.toContain('mk_agent');
      file.cleanup();
      expect(existsSync(dirname(file.path))).toBe(false);
      file.cleanup();
      expect(writeMcpConfig({ key: null, port: 8420, connectors: null }, base)).toBeNull();
    } finally {
      if (before === undefined) delete process.env.METRO_AGENTS_DIR;
      else process.env.METRO_AGENTS_DIR = before;
      rmSync(base, { recursive: true, force: true });
    }
  });
});
