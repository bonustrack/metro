import { afterEach, beforeEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { readManifest } from '../src/runtime-install.js';

const CLI = join(import.meta.dir, '..');
const REPO = join(CLI, '..', '..');
const STATIONS = ['xmtp', 'telegram-bot', 'telegram', 'discord-bot', 'whatsapp', 'threema', 'outlook', 'gmail', 'webhook'];
const PATCH_KEY = 'baileys@7.0.0-rc14';
const PATCH_FILE = `patches/${PATCH_KEY}.patch`;
let root = '';
let cli = '';
let runtime = '';

function put(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function register(patchedDependencies: Record<string, string>): void {
  put(join(root, 'package.json'), JSON.stringify({ patchedDependencies }));
}

function stage(): ReturnType<typeof readManifest> {
  const run = spawnSync('node', [join(cli, 'scripts', 'stage-runtime.mjs')], { encoding: 'utf8' });
  expect(run.stderr).toBe('');
  expect(run.status).toBe(0);
  return readManifest(join(runtime, 'stations.json'));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'metro-stage-patches-'));
  cli = join(root, 'packages', 'cli');
  runtime = join(cli, 'runtime');
  mkdirSync(join(cli, 'scripts'), { recursive: true });
  copyFileSync(join(CLI, 'scripts', 'stage-runtime.mjs'), join(cli, 'scripts', 'stage-runtime.mjs'));
  copyFileSync(join(CLI, 'package.json'), join(cli, 'package.json'));
  for (const source of ['apps/daemon', 'packages/core', 'packages/http', 'packages/sdk-runner', ...STATIONS.map((name) => `packages/${name}`)]) {
    mkdirSync(join(root, source, 'src'), { recursive: true });
    copyFileSync(join(REPO, source, 'package.json'), join(root, source, 'package.json'));
  }
  put(join(root, '.claude-plugin', 'marketplace.json'), '{}');
  put(join(root, 'plugin', '.claude-plugin', 'plugin.json'), '{}');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

test('the runtime stages only its registered vendor patch with a byte-derived path', () => {
  const content = 'first patch\n';
  register({ [PATCH_KEY]: PATCH_FILE, 'expo-router@57.0.23': 'patches/not-present.patch' });
  put(join(root, PATCH_FILE), content);
  const manifest = stage();
  const hash = createHash('sha256').update(content).digest('hex');
  expect(manifest.patchedDependencies).toEqual({ [PATCH_KEY]: `patches/${hash}.patch` });
  expect(readFileSync(join(runtime, `patches/${hash}.patch`), 'utf8')).toBe(content);
  expect(readdirSync(join(runtime, 'patches'))).toEqual([`${hash}.patch`]);
  expect(manifest.stations.whatsapp?.baileys).toBe('7.0.0-rc14');
});

test('a same-version patch edit changes the manifest and removes the old staged asset', () => {
  register({ [PATCH_KEY]: PATCH_FILE });
  put(join(root, PATCH_FILE), 'first patch');
  const first = stage();
  const version = readFileSync(join(runtime, 'runtime.json'), 'utf8');
  put(join(root, PATCH_FILE), 'second patch');
  const second = stage();
  expect(second.patchedDependencies).not.toEqual(first.patchedDependencies);
  expect(existsSync(join(runtime, first.patchedDependencies?.[PATCH_KEY] ?? ''))).toBe(false);
  expect(readFileSync(join(runtime, second.patchedDependencies?.[PATCH_KEY] ?? ''), 'utf8')).toBe('second patch');
  expect(readFileSync(join(runtime, 'runtime.json'), 'utf8')).toBe(version);
});

test('unpatched metadata and patches for other vendor versions leave the legacy manifest alone', () => {
  put(join(root, 'package.json'), '{}');
  const legacy = stage();
  expect(legacy).not.toHaveProperty('patchedDependencies');
  register({ 'baileys@7.0.0-rc13': 'patches/not-present.patch' });
  expect(stage()).toEqual(legacy);
  expect(existsSync(join(runtime, 'patches'))).toBe(false);
});
