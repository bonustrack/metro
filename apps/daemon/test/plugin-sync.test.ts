import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installedPluginFiles, syncPluginServers } from '../src/connectors/plugin-sync.ts';

const MCP = 'https://mcp.metro.box';
const ENTRY = { mcp: { type: 'http', url: MCP, headersHelper: 'node "${CLAUDE_PLUGIN_ROOT}/bin/metro-plugin.mjs" mcp-headers' } };
let dir = '';

function installPlugin(...where: string[]): string {
  const plugin = join(dir, 'plugins', ...where);
  mkdirSync(join(plugin, 'bin'), { recursive: true });
  writeFileSync(join(plugin, 'bin', 'metro-plugin.mjs'), '// metro\n');
  writeFileSync(join(plugin, '.mcp.json'), '{}\n');
  return join(plugin, '.mcp.json');
}

function stagedPlugin(store: string): string {
  const staged = join(store, 'marketplace', 'plugin');
  mkdirSync(join(staged, 'bin'), { recursive: true });
  writeFileSync(join(staged, 'bin', 'metro-plugin.mjs'), '// metro\n');
  writeFileSync(join(staged, '.mcp.json'), '{}\n');
  return staged;
}

const written = (file: string): unknown => JSON.parse(readFileSync(file, 'utf8'));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'metro-plugin-sync-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('where the plugin servers are written', () => {
  test('the plugin is found whatever layout Claude Code used to install it', () => {
    const marketplace = installPlugin('marketplaces', 'metro', 'plugin');
    const repo = installPlugin('repos', 'bonustrack', 'metro', 'plugin');
    expect(installedPluginFiles(dir, null).sort()).toEqual([marketplace, repo].sort());
  });

  test('the bundled marketplace counts too, since a plugin installed from a directory marketplace is loaded from there', () => {
    const cached = installPlugin('cache', 'metro', 'metro', '0.1.0-beta.114');
    const store = mkdtempSync(join(tmpdir(), 'metro-plugin-store-'));
    try {
      const staged = stagedPlugin(store);
      expect(installedPluginFiles(dir, staged).sort()).toEqual([cached, join(staged, '.mcp.json')].sort());
      expect(installedPluginFiles(dir, join(store, 'nowhere', 'plugin'))).toEqual([cached]);
    } finally {
      rmSync(store, { recursive: true, force: true });
    }
  });

  test('only a metro plugin is written, and only when its file would change', () => {
    const mine = installPlugin('marketplaces', 'metro', 'plugin');
    const other = join(dir, 'plugins', 'marketplaces', 'someone-else', 'plugin');
    mkdirSync(join(other, 'bin'), { recursive: true });
    writeFileSync(join(other, 'bin', 'other-plugin.mjs'), '// not metro\n');
    writeFileSync(join(other, '.mcp.json'), '{}\n');
    expect(installedPluginFiles(dir)).toEqual([mine]);

    expect(syncPluginServers({ dir, url: MCP })).toBe(1);
    expect(written(mine)).toEqual(ENTRY);
    expect(readFileSync(join(other, '.mcp.json'), 'utf8')).toBe('{}\n');
    expect(syncPluginServers({ dir, url: MCP })).toBe(0);
  });

  test('a machine with no metro plugin installed is left alone', () => {
    expect(syncPluginServers({ dir, url: MCP })).toBe(0);
    expect(existsSync(join(dir, 'plugins'))).toBe(false);
  });
});

describe('the one server, mcp', () => {
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

  test('is written into the installed plugin and the bundled marketplace alike, with no credential and no other server', () => {
    const cached = installPlugin('cache', 'metro', 'metro', '0.9.20');
    writeFileSync(cached, `${JSON.stringify({ linear: { type: 'http', url: 'http://127.0.0.1:8420/relay/org-conn0000001' } })}\n`);
    const store = mkdtempSync(join(tmpdir(), 'metro-plugin-store-'));
    try {
      const staged = stagedPlugin(store);
      expect(withUrl(undefined, () => syncPluginServers({ dir, staged }))).toBe(2);
      for (const file of [cached, join(staged, '.mcp.json')]) {
        expect(written(file)).toEqual(ENTRY);
        expect(readFileSync(file, 'utf8')).not.toContain('Bearer');
      }
    } finally {
      rmSync(store, { recursive: true, force: true });
    }
  });

  test('follows METRO_MCP_SERVER_URL, and an empty value leaves no server at all', () => {
    const cached = installPlugin('cache', 'metro', 'metro', '0.9.20');
    expect(withUrl('http://127.0.0.1:18430/', () => syncPluginServers({ dir, staged: null }))).toBe(1);
    expect(written(cached)).toEqual({ mcp: { ...ENTRY.mcp, url: 'http://127.0.0.1:18430' } });
    expect(withUrl('', () => syncPluginServers({ dir, staged: null }))).toBe(1);
    expect(readFileSync(cached, 'utf8').trim()).toBe('{}');
  });
});
