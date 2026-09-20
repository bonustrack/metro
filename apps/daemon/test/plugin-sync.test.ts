import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installedPluginFiles, pluginServers, serverKey, syncPluginServers, type PluginRow } from '../src/connectors/plugin-sync.ts';

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
    const servers = pluginServers([row('conn0000001', 'Snapshot Box')], BASE);
    expect(servers).toEqual({
      'snapshot-box': {
        type: 'http',
        url: `${BASE}/relay/conn0000001`,
        headersHelper: 'node "${CLAUDE_PLUGIN_ROOT}/bin/metro-plugin.mjs" headers',
      },
    });
    expect(JSON.stringify(servers)).not.toContain('Bearer');
  });

  test('a name becomes a key Claude Code can put in a tool name, and two alike keys stay apart', () => {
    expect(serverKey('Snapshot Box')).toBe('snapshot-box');
    expect(serverKey('  ***  ')).toBe('connector');
    expect(serverKey('a'.repeat(60))).toHaveLength(40);
    const both = pluginServers([row('conn0000001', 'Linear'), row('conn0000002', 'linear!')], BASE);
    expect(Object.keys(both)).toEqual(['linear', 'linear-conn']);
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

    expect(syncPluginServers([row('conn0000001', 'Piston Vault')], { dir, base: BASE, staged })).toBe(2);
    const written = JSON.parse(readFileSync(join(staged, '.mcp.json'), 'utf8')) as Record<string, { url: string }>;
    expect(written['piston-vault']?.url).toBe(`${BASE}/relay/conn0000001`);
    rmSync(store, { recursive: true, force: true });
  });

  test('only a metro plugin is written, and only when its file would change', () => {
    const mine = installPlugin('marketplaces', 'metro', 'plugin');
    const other = join(dir, 'plugins', 'marketplaces', 'someone-else', 'plugin');
    mkdirSync(join(other, 'bin'), { recursive: true });
    writeFileSync(join(other, 'bin', 'other-plugin.mjs'), '// not metro\n');
    writeFileSync(join(other, '.mcp.json'), '{}\n');
    expect(installedPluginFiles(dir)).toEqual([mine]);

    expect(syncPluginServers([row('conn0000001', 'Snapshot Box')], { dir, base: BASE })).toBe(1);
    const written = JSON.parse(readFileSync(mine, 'utf8')) as Record<string, { url: string }>;
    expect(written['snapshot-box']?.url).toBe(`${BASE}/relay/conn0000001`);
    expect(readFileSync(join(other, '.mcp.json'), 'utf8')).toBe('{}\n');

    expect(syncPluginServers([row('conn0000001', 'Snapshot Box')], { dir, base: BASE })).toBe(0);
    expect(syncPluginServers([row('conn0000001', 'Snapshot Box'), row('conn0000002', 'Jira')], { dir, base: BASE })).toBe(1);
    expect(Object.keys(JSON.parse(readFileSync(mine, 'utf8')) as Record<string, unknown>)).toEqual(['snapshot-box', 'jira']);

    expect(syncPluginServers([], { dir, base: BASE })).toBe(1);
    expect(readFileSync(mine, 'utf8').trim()).toBe('{}');
  });

  test('a machine with no metro plugin installed is left alone', () => {
    expect(syncPluginServers([row('conn0000001', 'Snapshot Box')], { dir, base: BASE })).toBe(0);
    expect(existsSync(join(dir, 'plugins'))).toBe(false);
  });
});
