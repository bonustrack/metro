import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installedPluginFiles, pluginServers, serverKey, syncPluginServers } from '../src/connectors/plugin-sync.ts';
import type { LocalConnectorRow } from '../src/connectors/store.ts';

const BASE = 'http://127.0.0.1:8420';
let dir = '';
let agents = '';

const row = (id: string, name: string): LocalConnectorRow => ({
  id,
  name,
  url: 'https://vendor.example/mcp',
  transport: 'http',
  config: { auth: { kind: 'none' }, createdAt: '2026-09-10T09:00:00.000Z', oauth: false, verified: { at: '', server: '', version: '', protocol: '', icon: '', tools: 0, catalog: [] } },
});

function installPlugin(...where: string[]): string {
  const plugin = join(dir, 'plugins', ...where);
  mkdirSync(join(plugin, 'bin'), { recursive: true });
  writeFileSync(join(plugin, 'bin', 'metro-plugin.mjs'), '// metro\n');
  writeFileSync(join(plugin, '.mcp.json'), '{}\n');
  return join(plugin, '.mcp.json');
}

function writeConnectors(rows: LocalConnectorRow[]): void {
  writeFileSync(join(agents, 'connectors.json'), JSON.stringify({ version: 1, connectors: rows }, null, 2));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'metro-plugin-sync-'));
  agents = mkdtempSync(join(tmpdir(), 'metro-plugin-agents-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(agents, { recursive: true, force: true });
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
    expect(installedPluginFiles(dir).sort()).toEqual([marketplace, repo].sort());
  });

  test('only a metro plugin is written, and only when its file would change', () => {
    const mine = installPlugin('marketplaces', 'metro', 'plugin');
    const other = join(dir, 'plugins', 'marketplaces', 'someone-else', 'plugin');
    mkdirSync(join(other, 'bin'), { recursive: true });
    writeFileSync(join(other, 'bin', 'other-plugin.mjs'), '// not metro\n');
    writeFileSync(join(other, '.mcp.json'), '{}\n');
    expect(installedPluginFiles(dir)).toEqual([mine]);

    writeConnectors([row('conn0000001', 'Snapshot Box')]);
    expect(syncPluginServers({ dir, base: BASE, agents })).toBe(1);
    const written = JSON.parse(readFileSync(mine, 'utf8')) as Record<string, { url: string }>;
    expect(written['snapshot-box']?.url).toBe(`${BASE}/relay/conn0000001`);
    expect(readFileSync(join(other, '.mcp.json'), 'utf8')).toBe('{}\n');

    expect(syncPluginServers({ dir, base: BASE, agents })).toBe(0);
    writeConnectors([row('conn0000001', 'Snapshot Box'), row('conn0000002', 'Jira')]);
    expect(syncPluginServers({ dir, base: BASE, agents })).toBe(1);
    expect(Object.keys(JSON.parse(readFileSync(mine, 'utf8')) as Record<string, unknown>)).toEqual(['snapshot-box', 'jira']);

    writeConnectors([]);
    expect(syncPluginServers({ dir, base: BASE, agents })).toBe(1);
    expect(readFileSync(mine, 'utf8').trim()).toBe('{}');
  });

  test('a machine with no metro plugin installed is left alone', () => {
    writeConnectors([row('conn0000001', 'Snapshot Box')]);
    expect(syncPluginServers({ dir, base: BASE, agents })).toBe(0);
    expect(existsSync(join(dir, 'plugins'))).toBe(false);
  });
});
