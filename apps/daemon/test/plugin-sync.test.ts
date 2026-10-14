import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installedPluginFiles, pluginServers, serverKey, serverKeysOf, syncPluginServers, type PluginRow } from '../src/connectors/plugin-sync.ts';

const BASE = 'http://127.0.0.1:8420';
let dir = '';

const row = (id: string, name: string): PluginRow => ({ id, name });

function installPlugin(...where: string[]): string {
  const plugin = join(dir, 'plugins', ...where);
  mkdirSync(join(plugin, 'bin'), { recursive: true });
  writeFileSync(join(plugin, 'bin', 'metro-plugin.mjs'), '// metro\n');
  writeFileSync(join(plugin, '.mcp.json'), '{}\n');
  return join(plugin, '.mcp.json');
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'metro-plugin-sync-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('the server list the plugin registers', () => {
  test('a connector becomes one MCP server at its own relay url, with no credential in the file', () => {
    const servers = pluginServers([row('org-conn0000001', 'Snapshot Box')], BASE);
    expect(servers).toEqual({
      'snapshot-box': {
        type: 'http',
        url: `${BASE}/relay/org-conn0000001`,
        headersHelper: 'node "${CLAUDE_PLUGIN_ROOT}/bin/metro-plugin.mjs" headers',
      },
    });
    expect(JSON.stringify(servers)).not.toContain('Bearer');
  });

  test('a name becomes a key Claude Code can put in a tool name, and two alike keys stay apart', () => {
    expect(serverKey('Snapshot Box')).toBe('snapshot-box');
    expect(serverKey('  ***  ')).toBe('connector');
    expect(serverKey('a'.repeat(60))).toHaveLength(40);
    const both = pluginServers([row('org-conn0000002', 'linear!'), row('org-conn0000001', 'Linear')], BASE);
    expect(Object.keys(both)).toEqual(['linear', 'linear-1']);
    expect(both.linear?.url).toBe(`${BASE}/relay/org-conn0000001`);
  });

  test('the plugin is found whatever layout Claude Code used to install it', () => {
    const marketplace = installPlugin('marketplaces', 'metro', 'plugin');
    const repo = installPlugin('repos', 'bonustrack', 'metro', 'plugin');
    expect(installedPluginFiles(dir, null).sort()).toEqual([marketplace, repo].sort());
  });

  test('the bundled marketplace is written too, since a plugin installed from a directory marketplace is loaded from there', () => {
    const cached = installPlugin('cache', 'metro', 'metro', '0.1.0-beta.114');
    const store = mkdtempSync(join(tmpdir(), 'metro-plugin-store-'));
    const staged = join(store, 'marketplace', 'plugin');
    mkdirSync(join(staged, 'bin'), { recursive: true });
    writeFileSync(join(staged, 'bin', 'metro-plugin.mjs'), '// metro\n');
    writeFileSync(join(staged, '.mcp.json'), '{}\n');
    expect(installedPluginFiles(dir, staged).sort()).toEqual([cached, join(staged, '.mcp.json')].sort());
    expect(installedPluginFiles(dir, join(store, 'nowhere', 'plugin'))).toEqual([cached]);

    expect(syncPluginServers([row('org-conn0000001', 'Piston Vault')], { dir, base: BASE, staged })).toBe(2);
    const written = JSON.parse(readFileSync(join(staged, '.mcp.json'), 'utf8')) as Record<string, { url: string }>;
    expect(written['piston-vault']?.url).toBe(`${BASE}/relay/org-conn0000001`);
    rmSync(store, { recursive: true, force: true });
  });

  test('only a metro plugin is written, and only when its file would change', () => {
    const mine = installPlugin('marketplaces', 'metro', 'plugin');
    const other = join(dir, 'plugins', 'marketplaces', 'someone-else', 'plugin');
    mkdirSync(join(other, 'bin'), { recursive: true });
    writeFileSync(join(other, 'bin', 'other-plugin.mjs'), '// not metro\n');
    writeFileSync(join(other, '.mcp.json'), '{}\n');
    expect(installedPluginFiles(dir)).toEqual([mine]);

    expect(syncPluginServers([row('org-conn0000001', 'Snapshot Box')], { dir, base: BASE })).toBe(1);
    const written = JSON.parse(readFileSync(mine, 'utf8')) as Record<string, { url: string }>;
    expect(written['snapshot-box']?.url).toBe(`${BASE}/relay/org-conn0000001`);
    expect(readFileSync(join(other, '.mcp.json'), 'utf8')).toBe('{}\n');

    expect(syncPluginServers([row('org-conn0000001', 'Snapshot Box')], { dir, base: BASE })).toBe(0);
    expect(syncPluginServers([row('org-conn0000001', 'Snapshot Box'), row('org-conn0000002', 'Jira')], { dir, base: BASE })).toBe(1);
    expect(Object.keys(JSON.parse(readFileSync(mine, 'utf8')) as Record<string, unknown>)).toEqual(['snapshot-box', 'jira']);

    expect(syncPluginServers([], { dir, base: BASE })).toBe(1);
    expect(readFileSync(mine, 'utf8').trim()).toBe('{}');
  });

  test('a machine with no metro plugin installed is left alone', () => {
    expect(syncPluginServers([row('org-conn0000001', 'Snapshot Box')], { dir, base: BASE })).toBe(0);
    expect(existsSync(join(dir, 'plugins'))).toBe(false);
  });
});

describe('the mcp.metro.box server', () => {
  const MCP = 'https://mcp.metro.box';
  const withUrl = <T>(url: string | undefined, run: () => T): T => {
    const saved = process.env.METRO_MCP_SERVER_URL;
    if (url === undefined) delete process.env.METRO_MCP_SERVER_URL;
    else process.env.METRO_MCP_SERVER_URL = url;
    try {
      return run();
    } finally {
      if (saved === undefined) delete process.env.METRO_MCP_SERVER_URL;
      else process.env.METRO_MCP_SERVER_URL = saved;
    }
  };

  test('is one more server, mcp, next to the connectors, only when METRO_MCP_SERVER_URL is set, with no credential in the file', () => {
    const rows = [row('org-conn0000001', 'Snapshot Box')];
    expect(Object.keys(withUrl(undefined, () => pluginServers(rows, BASE)))).toEqual(['snapshot-box']);
    const servers = withUrl(`${MCP}/`, () => pluginServers(rows, BASE));
    expect(Object.keys(servers)).toEqual(['snapshot-box', 'mcp']);
    expect(servers.mcp).toEqual({ type: 'http', url: MCP, headersHelper: 'node "${CLAUDE_PLUGIN_ROOT}/bin/metro-plugin.mjs" mcp-headers' });
    expect(JSON.stringify(servers)).not.toContain('Bearer');
  });

  test('keeps the key mcp for itself while set: a connector named MCP gets another key, a saved mcp key moves', () => {
    const rows = [row('org-conn0000001', 'MCP')];
    expect(withUrl(undefined, () => serverKeysOf(rows)).get('org-conn0000001')).toBe('mcp');
    expect(withUrl(undefined, () => serverKeysOf(rows, new Map([['org-conn0000001', 'mcp']]))).get('org-conn0000001')).toBe('mcp');
    expect(withUrl(MCP, () => serverKeysOf(rows)).get('org-conn0000001')).toBe('mcp-1');
    expect(withUrl(MCP, () => serverKeysOf(rows, new Map([['org-conn0000001', 'mcp']]))).get('org-conn0000001')).toBe('mcp-1');
    const servers = withUrl(MCP, () => pluginServers(rows, BASE));
    expect(servers.mcp?.url).toBe(MCP);
    expect(servers['mcp-1']?.url).toBe(`${BASE}/relay/org-conn0000001`);
  });

  test('is written into the installed plugin and the bundled marketplace alike', () => {
    const cached = installPlugin('cache', 'metro', 'metro', '0.9.20');
    const store = mkdtempSync(join(tmpdir(), 'metro-plugin-store-'));
    const staged = join(store, 'marketplace', 'plugin');
    mkdirSync(join(staged, 'bin'), { recursive: true });
    writeFileSync(join(staged, 'bin', 'metro-plugin.mjs'), '// metro\n');
    writeFileSync(join(staged, '.mcp.json'), '{}\n');
    try {
      expect(withUrl(MCP, () => syncPluginServers([], { dir, base: BASE, staged }))).toBe(2);
      for (const file of [cached, join(staged, '.mcp.json')])
        expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ mcp: { type: 'http', url: MCP, headersHelper: 'node "${CLAUDE_PLUGIN_ROOT}/bin/metro-plugin.mjs" mcp-headers' } });
      expect(withUrl(undefined, () => syncPluginServers([], { dir, base: BASE, staged }))).toBe(2);
      expect(readFileSync(cached, 'utf8').trim()).toBe('{}');
    } finally {
      rmSync(store, { recursive: true, force: true });
    }
  });
});
