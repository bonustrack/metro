import { afterEach, beforeEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareRuntime, readManifest as readCliManifest } from '../../../packages/cli/src/runtime-install.js';
import { installRuntime, readManifest, type RuntimeManifest } from '../src/stations/runtime-deps.js';

const PATCH_KEY = 'baileys@7.0.0-rc14';
const MANIFEST: RuntimeManifest = {
  core: { pino: '^9' },
  stations: { xmtp: { '@xmtp/node-sdk': '^6' }, whatsapp: { baileys: '7.0.0-rc14' } },
};
const savedPath = process.env.PATH;
let root = '';
let sources = '';
let bun = '';
let agents = '';

function stage(content?: string): RuntimeManifest {
  const manifest: RuntimeManifest = { ...MANIFEST };
  if (content !== undefined) {
    const path = `patches/${createHash('sha256').update(content).digest('hex')}.patch`;
    mkdirSync(join(sources, 'patches'), { recursive: true });
    writeFileSync(join(sources, path), content);
    manifest.patchedDependencies = { [PATCH_KEY]: path };
  }
  writeFileSync(join(sources, 'stations.json'), JSON.stringify(manifest));
  return manifest;
}

function accounts(stations: string[]): void {
  writeFileSync(join(agents, 'agent.json'), JSON.stringify({
    id: 'fixture', key: 'fixture', stations: stations.map((station) => ({ station })),
  }));
}

function prepare(store: string): void {
  prepareRuntime({ sources, store, agents, bun, log: () => undefined });
}

const packageText = (store: string): string => readFileSync(join(store, 'package.json'), 'utf8');
const calls = (store: string): number => readFileSync(join(store, 'calls'), 'utf8').trim().split('\n').length;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'metro-runtime-patches-'));
  sources = join(root, 'sources');
  agents = join(root, 'agents');
  mkdirSync(agents);
  mkdirSync(join(sources, 'node_modules', '@metro-labs'), { recursive: true });
  writeFileSync(join(sources, 'runtime.json'), '{"version":"1"}');
  writeFileSync(join(sources, 'server.ts'), '');
  bun = join(root, 'bun');
  writeFileSync(bun, `#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync('calls', process.argv.slice(2).join(' ') + '\\n');
if (fs.existsSync('fail')) process.exit(3);
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
for (const path of Object.values(pkg.patchedDependencies ?? {})) {
  if (!fs.existsSync(path)) process.exit(4);
}
fs.mkdirSync('node_modules', { recursive: true });
fs.copyFileSync('package.json', 'installed.json');
`);
  chmodSync(bun, 0o755);
  process.env.PATH = `${root}:${savedPath ?? ''}`;
});

afterEach(() => {
  process.env.PATH = savedPath;
  rmSync(root, { recursive: true, force: true });
});

test('cold install and later attachment keep byte-identical packages and existing SDKs', () => {
  const manifest = stage('first patch');
  const manifestFile = join(sources, 'stations.json');
  expect(readCliManifest(manifestFile)).toEqual(readManifest(manifestFile));
  const attached = join(root, 'attached');
  accounts(['xmtp']);
  prepare(attached);
  expect(JSON.parse(packageText(attached))).not.toHaveProperty('patchedDependencies');
  const path = manifest.patchedDependencies?.[PATCH_KEY] ?? '';
  expect(readFileSync(join(attached, path), 'utf8')).toBe('first patch');
  const sdk = join(attached, 'node_modules', 'existing-sdk');
  writeFileSync(sdk, 'keep');
  const store = { dir: attached, manifest: readManifest(manifestFile) };
  expect(installRuntime(store, ['xmtp', 'whatsapp'])).toBe(true);
  expect(JSON.parse(packageText(attached))).toEqual({
    name: 'metro-runtime', private: true,
    dependencies: { '@xmtp/node-sdk': '^6', baileys: '7.0.0-rc14', pino: '^9' },
    patchedDependencies: { [PATCH_KEY]: path },
  });
  expect(readFileSync(join(attached, 'installed.json'), 'utf8')).toBe(packageText(attached));
  accounts(['whatsapp', 'xmtp']);
  const cold = join(root, 'cold');
  prepare(cold);
  expect(packageText(cold)).toBe(packageText(attached));
  expect(readFileSync(join(cold, path), 'utf8')).toBe('first patch');
  prepare(attached);
  expect(installRuntime(store, ['whatsapp', 'xmtp'])).toBe(false);
  expect(calls(attached)).toBe(2);
  expect(calls(cold)).toBe(1);
  expect(readFileSync(sdk, 'utf8')).toBe('keep');
});

test('patch content changes reinstall at the same Metro and vendor versions, then cache again', () => {
  stage('first patch');
  accounts(['whatsapp', 'xmtp']);
  const dir = join(root, 'store');
  prepare(dir);
  const first = packageText(dir);
  const manifest = stage('second patch');
  prepare(dir);
  expect(packageText(dir)).not.toBe(first);
  expect(readFileSync(join(dir, manifest.patchedDependencies?.[PATCH_KEY] ?? ''), 'utf8')).toBe('second patch');
  expect(JSON.parse(packageText(dir)).dependencies.baileys).toBe('7.0.0-rc14');
  expect(calls(dir)).toBe(2);
  expect(installRuntime({ dir, manifest }, ['xmtp', 'whatsapp'])).toBe(false);
  prepare(dir);
  expect(calls(dir)).toBe(2);
});

test('an unused patch update does not reinstall SDKs', () => {
  stage('first patch');
  accounts(['xmtp']);
  const dir = join(root, 'store');
  prepare(dir);
  const manifest = stage('second patch');
  prepare(dir);
  expect(calls(dir)).toBe(1);
  expect(installRuntime({ dir, manifest }, ['xmtp', 'whatsapp'])).toBe(true);
  expect(readFileSync(join(dir, manifest.patchedDependencies?.[PATCH_KEY] ?? ''), 'utf8')).toBe('second patch');
});

test('a failed patched attachment clears an earlier success marker and retries', () => {
  const manifest = stage('first patch');
  accounts(['xmtp']);
  const dir = join(root, 'store');
  prepare(dir);
  writeFileSync(join(dir, 'fail'), '');
  const store = { dir, manifest };
  expect(() => installRuntime(store, ['xmtp', 'whatsapp'])).toThrow('exit 3');
  expect(existsSync(join(dir, 'node_modules', '.metro-installed'))).toBe(false);
  rmSync(join(dir, 'fail'));
  expect(installRuntime(store, ['xmtp', 'whatsapp'])).toBe(true);
  expect(calls(dir)).toBe(3);
  accounts(['xmtp', 'whatsapp']);
  prepare(dir);
  expect(calls(dir)).toBe(3);
});

test('a failed patch upgrade retries from the CLI even when package bytes already match', () => {
  stage('first patch');
  accounts(['whatsapp']);
  const dir = join(root, 'store');
  prepare(dir);
  stage('second patch');
  writeFileSync(join(dir, 'fail'), '');
  expect(() => prepare(dir)).toThrow('exit 3');
  expect(existsSync(join(dir, 'node_modules', '.metro-installed'))).toBe(false);
  rmSync(join(dir, 'fail'));
  prepare(dir);
  expect(calls(dir)).toBe(3);
});

test('legacy manifests without patches keep the same package contract in both writers', () => {
  const manifest = stage();
  accounts(['whatsapp', 'xmtp']);
  const dir = join(root, 'store');
  prepare(dir);
  expect(readManifest(join(sources, 'stations.json'))).toEqual(MANIFEST);
  expect(installRuntime({ dir, manifest }, ['xmtp', 'whatsapp'])).toBe(false);
  expect(JSON.parse(packageText(dir))).not.toHaveProperty('patchedDependencies');
  expect(calls(dir)).toBe(1);
});

test('a missing staged patch refuses preparation instead of installing an unpatched SDK', () => {
  stage('first patch');
  accounts(['whatsapp']);
  rmSync(join(sources, 'patches'), { recursive: true });
  const dir = join(root, 'store');
  expect(() => prepare(dir)).toThrow('ENOENT');
  expect(existsSync(join(dir, 'calls'))).toBe(false);
});
