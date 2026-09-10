import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureMetroPlugin, stagedMarketplaceDir, stagedPluginVersion, type Answer, type Run } from '../src/claude/plugin-install.ts';

let dir = '';
let market = '';

interface World {
  marketplaces: { name: string; source: string; path?: string; installLocation?: string }[];
  installed: { id: string; version: string }[];
  refuse: Set<string>;
}

function fakeClaude(world: World, calls: string[]): Run {
  return (args) => {
    const line = args.join(' ');
    calls.push(line);
    const ok = (stdout = ''): Answer => ({ status: 0, stdout, stderr: '' });
    if (world.refuse.has(line)) return Promise.resolve({ status: 1, stdout: '', stderr: 'no' });
    if (line === 'plugin marketplace list --json') return Promise.resolve(ok(JSON.stringify(world.marketplaces)));
    if (line === 'plugin list --json') return Promise.resolve(ok(JSON.stringify(world.installed)));
    if (line.startsWith('plugin marketplace remove ')) {
      world.marketplaces = world.marketplaces.filter((m) => m.name !== 'metro');
      return Promise.resolve(ok());
    }
    if (line.startsWith('plugin marketplace add ')) {
      world.marketplaces.push({ name: 'metro', source: 'directory', path: market, installLocation: market });
      return Promise.resolve(ok());
    }
    if (line.startsWith('plugin install ')) {
      world.installed.push({ id: 'metro@metro', version: stagedPluginVersion(market) ?? '' });
      return Promise.resolve(ok());
    }
    if (line.startsWith('plugin update ')) {
      world.installed = world.installed.map((p) => (p.id === 'metro@metro' ? { ...p, version: stagedPluginVersion(market) ?? '' } : p));
      return Promise.resolve(ok());
    }
    return Promise.resolve(ok());
  };
}

function stage(version: string): void {
  mkdirSync(join(market, '.claude-plugin'), { recursive: true });
  mkdirSync(join(market, 'plugin', '.claude-plugin'), { recursive: true });
  writeFileSync(join(market, '.claude-plugin', 'marketplace.json'), JSON.stringify({ name: 'metro', plugins: [{ name: 'metro', source: './plugin' }] }));
  writeFileSync(join(market, 'plugin', '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'metro', version }));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'metro-plugin-install-'));
  market = join(dir, 'marketplace');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('the bundled plugin marketplace', () => {
  test('is found through the runtime store, and only when it is staged', () => {
    expect(stagedMarketplaceDir({ METRO_RUNTIME_STORE: dir })).toBeNull();
    stage('0.1.0-beta.97');
    expect(stagedMarketplaceDir({ METRO_RUNTIME_STORE: dir })).toBe(market);
    expect(stagedMarketplaceDir({})).toBeNull();
    expect(stagedPluginVersion(market)).toBe('0.1.0-beta.97');
  });
});

describe('keeping the Claude Code plugin current', () => {
  test('a fresh machine gets the marketplace added and the plugin installed, at user scope, without a prompt', async () => {
    stage('0.1.0-beta.97');
    const calls: string[] = [];
    const world: World = { marketplaces: [], installed: [], refuse: new Set() };
    expect(await ensureMetroPlugin({ run: fakeClaude(world, calls), marketplaceDir: market })).toBe('installed');
    expect(calls).toEqual(['plugin marketplace list --json', `plugin marketplace add ${market}`, 'plugin list --json', 'plugin install metro@metro -y --scope user']);
  });

  test('the GitHub marketplace a box used before is replaced by the bundled one, and the plugin reinstalled', async () => {
    stage('0.1.0-beta.97');
    const calls: string[] = [];
    const world: World = {
      marketplaces: [{ name: 'metro', source: 'github', installLocation: '/root/.claude/plugins/marketplaces/metro' }],
      installed: [],
      refuse: new Set(),
    };
    expect(await ensureMetroPlugin({ run: fakeClaude(world, calls), marketplaceDir: market })).toBe('installed');
    expect(calls).toEqual([
      'plugin marketplace list --json',
      'plugin marketplace remove metro',
      `plugin marketplace add ${market}`,
      'plugin list --json',
      'plugin install metro@metro -y --scope user',
    ]);
  });

  test('a plugin already at the staged version is left alone; an older one is updated through the marketplace', async () => {
    stage('0.1.0-beta.97');
    const same: World = {
      marketplaces: [{ name: 'metro', source: 'directory', path: market, installLocation: market }],
      installed: [{ id: 'metro@metro', version: '0.1.0-beta.97' }],
      refuse: new Set(),
    };
    const quiet: string[] = [];
    expect(await ensureMetroPlugin({ run: fakeClaude(same, quiet), marketplaceDir: market })).toBe('unchanged');
    expect(quiet).toEqual(['plugin marketplace list --json', 'plugin list --json']);

    const older: World = { ...same, installed: [{ id: 'metro@metro', version: '0.1.0-beta.90' }] };
    const calls: string[] = [];
    expect(await ensureMetroPlugin({ run: fakeClaude(older, calls), marketplaceDir: market })).toBe('updated');
    expect(calls.slice(2)).toEqual(['plugin marketplace update metro', 'plugin update metro@metro -y']);
  });

  test('no claude on the machine, or no staged marketplace, means nothing is touched', async () => {
    expect(await ensureMetroPlugin({ run: null, marketplaceDir: market })).toBe('skipped');
    stage('0.1.0-beta.97');
    const calls: string[] = [];
    expect(await ensureMetroPlugin({ run: fakeClaude({ marketplaces: [], installed: [], refuse: new Set() }, calls), marketplaceDir: null })).toBe('skipped');
    expect(calls).toEqual([]);
  });

  test('a refusal from claude is a failed outcome with the reason logged, never a throw', async () => {
    stage('0.1.0-beta.97');
    const calls: string[] = [];
    const world: World = { marketplaces: [], installed: [], refuse: new Set([`plugin marketplace add ${market}`]) };
    expect(await ensureMetroPlugin({ run: fakeClaude(world, calls), marketplaceDir: market })).toBe('failed');
  });
});
