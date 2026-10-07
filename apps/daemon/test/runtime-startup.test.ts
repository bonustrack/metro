import { afterEach, beforeEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dependenciesFor, installDependencies } from '../../../packages/cli/src/runtime-install.js';
import { setAgentMap, setDisabledAccounts } from '../src/agents/map.js';
import { ensureStationDeps, type RuntimeManifest } from '../src/stations/runtime-deps.js';

const PATCH = 'fixture deletion patch';
const PATCH_PATH = `patches/${createHash('sha256').update(PATCH).digest('hex')}.patch`;
const PATCH_KEY = 'baileys@7.0.0-rc14';
const MANIFEST: RuntimeManifest = {
  core: { pino: '^9' },
  stations: { xmtp: { '@xmtp/node-sdk': '^6' }, whatsapp: { baileys: '7.0.0-rc14' } },
  patchedDependencies: { [PATCH_KEY]: PATCH_PATH },
};
const savedEnv = { ...process.env };
let root = '';
let sources = '';
let store = '';
let bun = '';
const calls = (): number => readFileSync(join(store, 'calls'), 'utf8').trim().split('\n').length;
const marker = (): string => join(store, 'node_modules', '.metro-installed');
const packageText = (): string => readFileSync(join(store, 'package.json'), 'utf8');

function oldParent(): void {
  installDependencies(store, dependenciesFor(MANIFEST, ['xmtp', 'whatsapp']), bun, () => undefined);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'metro-runtime-startup-'));
  sources = join(root, 'sources');
  store = join(root, 'store');
  mkdirSync(join(sources, 'patches'), { recursive: true });
  mkdirSync(store);
  writeFileSync(join(sources, PATCH_PATH), PATCH);
  writeFileSync(join(sources, 'patches', 'unreferenced.patch'), 'do not copy');
  writeFileSync(join(sources, 'stations.json'), JSON.stringify(MANIFEST));
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
  process.env.PATH = `${root}:${savedEnv.PATH ?? ''}`;
  process.env.METRO_RUNTIME_STORE = store;
  process.env.METRO_RUNTIME_MANIFEST = join(sources, 'stations.json');
  setAgentMap({ 'xmtp/fixture-xmtp': 'fixture', 'whatsapp/fixture-wa': 'fixture' }, { fixture: 'Fixture' });
  setDisabledAccounts(new Set(['whatsapp/fixture-wa']));
  oldParent();
});

afterEach(() => {
  for (const key of ['PATH', 'METRO_RUNTIME_STORE', 'METRO_RUNTIME_MANIFEST']) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  setAgentMap({}, {});
  setDisabledAccounts(new Set());
  rmSync(root, { recursive: true, force: true });
});

test('startup repairs an old parent store, including Receive Off, on every child restart', () => {
  writeFileSync(join(store, 'node_modules', 'other-sdk'), 'keep');
  expect(existsSync(join(store, PATCH_PATH))).toBe(false);
  ensureStationDeps();
  expect(readFileSync(join(store, PATCH_PATH), 'utf8')).toBe(PATCH);
  expect(existsSync(join(store, 'patches', 'unreferenced.patch'))).toBe(false);
  expect(JSON.parse(packageText())).toEqual({
    name: 'metro-runtime', private: true,
    dependencies: { '@xmtp/node-sdk': '^6', baileys: '7.0.0-rc14', pino: '^9' },
    patchedDependencies: { [PATCH_KEY]: PATCH_PATH },
  });
  expect(readFileSync(join(store, 'installed.json'), 'utf8')).toBe(packageText());
  expect(calls()).toBe(2);
  ensureStationDeps();
  expect(calls()).toBe(2);
  oldParent();
  expect(JSON.parse(packageText())).not.toHaveProperty('patchedDependencies');
  ensureStationDeps();
  expect(calls()).toBe(4);
  expect(readFileSync(join(store, 'node_modules', 'other-sdk'), 'utf8')).toBe('keep');
});

test('startup applies changed patch bytes at the same vendor version and then caches', () => {
  ensureStationDeps();
  const patch = 'updated deletion patch';
  const path = `patches/${createHash('sha256').update(patch).digest('hex')}.patch`;
  writeFileSync(join(sources, path), patch);
  writeFileSync(join(sources, 'stations.json'), JSON.stringify({ ...MANIFEST, patchedDependencies: { [PATCH_KEY]: path } }));
  ensureStationDeps();
  expect(readFileSync(join(store, path), 'utf8')).toBe(patch);
  expect(JSON.parse(packageText()).patchedDependencies).toEqual({ [PATCH_KEY]: path });
  expect(calls()).toBe(3);
  ensureStationDeps();
  expect(calls()).toBe(3);
});

test('a missing staged patch and a failed install both refuse startup and retry', () => {
  rmSync(join(sources, PATCH_PATH));
  expect(() => ensureStationDeps()).toThrow('ENOENT');
  expect(existsSync(marker())).toBe(false);
  expect(calls()).toBe(1);
  writeFileSync(join(sources, PATCH_PATH), PATCH);
  writeFileSync(join(store, 'fail'), '');
  expect(() => ensureStationDeps()).toThrow('exit 3');
  expect(existsSync(marker())).toBe(false);
  rmSync(join(store, 'fail'));
  ensureStationDeps();
  expect(existsSync(marker())).toBe(true);
  expect(calls()).toBe(3);
});

test('startup copies assets before the cache check and refuses missing sources even when cached', () => {
  ensureStationDeps();
  rmSync(join(store, PATCH_PATH));
  ensureStationDeps();
  expect(readFileSync(join(store, PATCH_PATH), 'utf8')).toBe(PATCH);
  expect(calls()).toBe(2);
  rmSync(join(sources, PATCH_PATH));
  expect(() => ensureStationDeps()).toThrow('ENOENT');
  expect(existsSync(marker())).toBe(false);
});

test.each(['', '../outside.patch', '/tmp/outside.patch', 'patches/../outside.patch', 'patches/missing.patch', 7, null])(
  'invalid patch reference %p refuses instead of silently omitting the patch', (path) => {
    writeFileSync(join(sources, 'stations.json'), JSON.stringify({ ...MANIFEST, patchedDependencies: { [PATCH_KEY]: path } }));
    expect(() => ensureStationDeps()).toThrow('Invalid runtime patch');
    expect(calls()).toBe(1);
  },
);

test('patch directories and files cannot redirect copying through symlinks', () => {
  const outside = join(root, 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'keep'), 'unchanged');
  symlinkSync(outside, join(store, 'patches'));
  expect(() => ensureStationDeps()).toThrow('Invalid runtime patch');
  rmSync(join(store, 'patches'));
  mkdirSync(join(store, 'patches'));
  symlinkSync(join(outside, 'keep'), join(store, PATCH_PATH));
  expect(() => ensureStationDeps()).toThrow('Invalid runtime patch');
  rmSync(join(store, PATCH_PATH));
  rmSync(join(sources, PATCH_PATH));
  symlinkSync(join(outside, 'keep'), join(sources, PATCH_PATH));
  expect(() => ensureStationDeps()).toThrow('Invalid runtime patch');
  expect(readFileSync(join(outside, 'keep'), 'utf8')).toBe('unchanged');
  expect(calls()).toBe(1);
});

test('incorrect content under a hash-addressed patch path refuses startup', () => {
  writeFileSync(join(sources, PATCH_PATH), 'wrong patch');
  expect(() => ensureStationDeps()).toThrow('Invalid runtime patch contents');
  expect(existsSync(marker())).toBe(false);
  expect(calls()).toBe(1);
});

test('later attachment copies required assets without a patch-aware parent', () => {
  setAgentMap({ 'xmtp/fixture-xmtp': 'fixture' }, { fixture: 'Fixture' });
  ensureStationDeps('whatsapp');
  expect(readFileSync(join(store, PATCH_PATH), 'utf8')).toBe(PATCH);
  expect(calls()).toBe(2);
});

test('legacy manifests and development without runtime environment remain no-ops', () => {
  writeFileSync(join(sources, 'stations.json'), JSON.stringify({ core: MANIFEST.core, stations: MANIFEST.stations }));
  ensureStationDeps();
  expect(calls()).toBe(1);
  rmSync(join(sources, 'stations.json'));
  delete process.env.METRO_RUNTIME_MANIFEST;
  ensureStationDeps();
  process.env.METRO_RUNTIME_MANIFEST = join(sources, 'stations.json');
  delete process.env.METRO_RUNTIME_STORE;
  ensureStationDeps('whatsapp');
  expect(calls()).toBe(1);
});

test('boot reconciles the runtime after materialization and before the first train', () => {
  const boot = readFileSync(new URL('../src/boot/boot.ts', import.meta.url), 'utf8');
  const materialize = boot.indexOf('await materializeFrom(fileSource);');
  const repair = boot.indexOf('ensureStationDeps();', materialize);
  const start = boot.indexOf('supervisor.start();', materialize);
  expect(materialize).toBeGreaterThan(0);
  expect(repair).toBeGreaterThan(materialize);
  expect(repair).toBeLessThan(start);
});
