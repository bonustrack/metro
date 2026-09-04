import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dependenciesFor, installRuntime, readManifest, type RuntimeManifest } from '../src/daemon/runtime-deps.ts';

const MANIFEST: RuntimeManifest = {
  core: { pino: '^9', viem: '2.52.2', zod: '^3' },
  stations: {
    xmtp: { '@xmtp/node-sdk': '^6', viem: '2.52.2' },
    whatsapp: { baileys: '7.0.0-rc14' },
    webhook: {},
  },
};

let dir = '';
let bin = '';
let calls = '';
const savedPath = process.env.PATH;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'metro-runtime-'));
  bin = join(dir, 'bin');
  mkdirSync(bin);
  calls = join(dir, 'calls.log');
  writeFileSync(join(bin, 'bun'), `#!/bin/sh\necho "$PWD $*" >> ${calls}\nmkdir -p node_modules\n`);
  chmodSync(join(bin, 'bun'), 0o755);
  process.env.PATH = `${bin}:${savedPath ?? ''}`;
});

afterAll(() => {
  process.env.PATH = savedPath;
  rmSync(dir, { recursive: true, force: true });
});

describe('the per-channel runtime', () => {
  test('the dependency set is the core plus the channels present, sorted, and a manifest reads back the same', () => {
    expect(dependenciesFor(MANIFEST, ['whatsapp', 'webhook', 'whatsapp'])).toEqual({ baileys: '7.0.0-rc14', pino: '^9', viem: '2.52.2', zod: '^3' });
    expect(Object.keys(dependenciesFor(MANIFEST, []))).toEqual(['pino', 'viem', 'zod']);
    const path = join(dir, 'stations.json');
    writeFileSync(path, JSON.stringify(MANIFEST));
    expect(readManifest(path)).toEqual(MANIFEST);
  });

  test('installing writes the package file and runs bun once; an unchanged set runs nothing', () => {
    const store = { dir: join(dir, 'store'), manifest: MANIFEST };
    expect(installRuntime(store, ['xmtp'])).toBe(true);
    const pkg = JSON.parse(readFileSync(join(store.dir, 'package.json'), 'utf8')) as { dependencies: Record<string, string> };
    expect(Object.keys(pkg.dependencies)).toEqual(['@xmtp/node-sdk', 'pino', 'viem', 'zod']);
    expect(existsSync(join(store.dir, 'node_modules', '.metro-installed'))).toBe(true);
    expect(readFileSync(calls, 'utf8').trim().split('\n')).toHaveLength(1);
    expect(installRuntime(store, ['xmtp'])).toBe(false);
    expect(readFileSync(calls, 'utf8').trim().split('\n')).toHaveLength(1);
    expect(installRuntime(store, ['xmtp', 'whatsapp'])).toBe(true);
    expect(readFileSync(calls, 'utf8').trim().split('\n')).toHaveLength(2);
  });
});
