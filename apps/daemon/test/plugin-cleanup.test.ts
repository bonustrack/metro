import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeAt, removeMetroPlugin } from '../src/claude/plugin-cleanup.js';

interface World {
  plugins: { id: string; version: string }[];
  marketplaces: { name: string; source: string }[];
  refuse: string[];
}

let dir = '';
let agents = '';
let leftover = '';

const statePath = (): string => join(dir, 'world.json');
const callsPath = (): string => join(dir, 'calls.log');

function fakeClaude(world: World): string {
  writeFileSync(statePath(), JSON.stringify(world));
  const bin = join(dir, 'claude');
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const line = args.join(' ');
fs.appendFileSync(${JSON.stringify(callsPath())}, line + '\\n');
const world = JSON.parse(fs.readFileSync(${JSON.stringify(statePath())}, 'utf8'));
const save = () => fs.writeFileSync(${JSON.stringify(statePath())}, JSON.stringify(world));
if (world.refuse.includes(line)) { process.stderr.write('refused'); process.exit(1); }
if (line === '--version') process.stdout.write('2.1.289 (Claude Code)\\n');
else if (line === 'plugin list --json') process.stdout.write(JSON.stringify(world.plugins));
else if (line === 'plugin marketplace list --json') process.stdout.write(JSON.stringify(world.marketplaces));
else if (args[0] === 'plugin' && args[1] === 'uninstall') { world.plugins = world.plugins.filter((p) => p.id !== args[2]); save(); }
else if (line.startsWith('plugin marketplace remove ')) { world.marketplaces = world.marketplaces.filter((m) => m.name !== args[3]); save(); }
else { process.stderr.write('unknown command'); process.exit(2); }
`,
  );
  chmodSync(bin, 0o755);
  return bin;
}

const calls = (): string[] => (existsSync(callsPath()) ? readFileSync(callsPath(), 'utf8').trim().split('\n').filter(Boolean) : []);
const world = (): World => JSON.parse(readFileSync(statePath(), 'utf8')) as World;
const marked = (): boolean => existsSync(join(agents, 'claude-setup.json')) && (JSON.parse(readFileSync(join(agents, 'claude-setup.json'), 'utf8')) as { pluginRemoved?: boolean }).pluginRemoved === true;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'metro-plugin-cleanup-'));
  agents = join(dir, 'agents');
  leftover = join(dir, 'home', '.metro', 'marketplace');
  mkdirSync(agents, { recursive: true });
  mkdirSync(join(leftover, 'plugin', 'bin'), { recursive: true });
  writeFileSync(join(leftover, 'plugin', 'bin', 'guard.mjs'), '');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('the one-time removal of the old metro Claude Code plugin', () => {
  test('uninstalls metro@metro, removes the metro marketplace and the agent copy, leaves other plugins, and runs once', async () => {
    const run = claudeAt(fakeClaude({
      plugins: [{ id: 'metro@metro', version: '0.9.21' }, { id: 'other@elsewhere', version: '1.0.0' }],
      marketplaces: [{ name: 'metro', source: 'directory' }, { name: 'elsewhere', source: 'github' }],
      refuse: [],
    }));
    expect(await removeMetroPlugin({ run, agents, leftover })).toBe('removed');
    expect(calls()).toEqual(['plugin list --json', 'plugin uninstall metro@metro', 'plugin marketplace list --json', 'plugin marketplace remove metro']);
    expect(world().plugins).toEqual([{ id: 'other@elsewhere', version: '1.0.0' }]);
    expect(world().marketplaces).toEqual([{ name: 'elsewhere', source: 'github' }]);
    expect(existsSync(leftover)).toBe(false);
    expect(marked()).toBe(true);
    expect(await removeMetroPlugin({ run, agents, leftover })).toBe('done');
    expect(calls()).toHaveLength(4);
  });

  test('a machine that never had the plugin only checks, once', async () => {
    rmSync(leftover, { recursive: true, force: true });
    const run = claudeAt(fakeClaude({ plugins: [], marketplaces: [], refuse: [] }));
    expect(await removeMetroPlugin({ run, agents, leftover })).toBe('clean');
    expect(calls()).toEqual(['plugin list --json', 'plugin marketplace list --json']);
    expect(marked()).toBe(true);
  });

  test('a refusal is never fatal and is tried again at the next start', async () => {
    const run = claudeAt(fakeClaude({ plugins: [{ id: 'metro@metro', version: '0.9.21' }], marketplaces: [{ name: 'metro', source: 'directory' }], refuse: ['plugin uninstall metro@metro'] }));
    expect(await removeMetroPlugin({ run, agents, leftover })).toBe('failed');
    expect(marked()).toBe(false);
    expect(world().marketplaces).toEqual([]);
    writeFileSync(statePath(), JSON.stringify({ ...world(), refuse: [] }));
    expect(await removeMetroPlugin({ run, agents, leftover })).toBe('removed');
    expect(world().plugins).toEqual([]);
    expect(marked()).toBe(true);
  });

  test('a list claude cannot answer counts as a failure, and no claude at all is skipped without a mark', async () => {
    const run = claudeAt(fakeClaude({ plugins: [], marketplaces: [], refuse: ['plugin list --json'] }));
    expect(await removeMetroPlugin({ run, agents, leftover })).toBe('failed');
    expect(existsSync(leftover)).toBe(false);
    expect(await removeMetroPlugin({ run: null, agents, leftover })).toBe('skipped');
    expect(marked()).toBe(false);
  });
});
