import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dependenciesFor, installDependencies, prepareRuntime, readManifest } from '../src/runtime-install.js';
import { SERVER_ENTRY } from '../src/runtime.js';

const MANIFEST = {
  core: { pino: '^9', viem: '2.52.2', zod: '^3' },
  stations: { xmtp: { '@xmtp/node-sdk': '^6', viem: '2.52.2' }, whatsapp: { baileys: '7.0.0-rc14' }, webhook: {} },
};

let root = '';
let bun = '';
let calls = '';
const lines: string[] = [];

function stageSources(version: string): string {
  const sources = join(root, `sources-${version}`);
  mkdirSync(join(sources, 'node_modules', '@metro-labs', 'mcp', 'src'), { recursive: true });
  writeFileSync(join(sources, 'node_modules', '@metro-labs', 'mcp', 'src', 'server.ts'), `export const v = '${version}';\n`);
  writeFileSync(join(sources, 'runtime.json'), JSON.stringify({ version }));
  writeFileSync(join(sources, 'stations.json'), JSON.stringify(MANIFEST));
  return sources;
}

function agentWith(stations: string[]): string {
  const agents = join(root, 'agents');
  mkdirSync(join(agents, 'suzy'), { recursive: true });
  writeFileSync(
    join(agents, 'suzy', 'agent.json'),
    JSON.stringify({ id: 'suzy', name: 'suzy', key: 'mk_x', stations: stations.map((station) => ({ station })) }),
  );
  return agents;
}

const installs = (): number => (existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n').length : 0);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'metro-cli-runtime-'));
  bun = join(root, 'bun');
  calls = join(root, 'calls.log');
  writeFileSync(bun, `#!/bin/sh\necho "$PWD $*" >> ${calls}\nmkdir -p node_modules\n`);
  chmodSync(bun, 0o755);
  lines.length = 0;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('the per-channel runtime store', () => {
  test('dependencies are the core plus the channels present, and a manifest round-trips', () => {
    expect(dependenciesFor(MANIFEST, ['whatsapp', 'webhook'])).toEqual({ baileys: '7.0.0-rc14', pino: '^9', viem: '2.52.2', zod: '^3' });
    const path = join(root, 'm.json');
    writeFileSync(path, JSON.stringify(MANIFEST));
    expect(readManifest(path)).toEqual(MANIFEST);
  });

  test('a first serve copies metro, installs only what the agent needs, and a second serve installs nothing', () => {
    const sources = stageSources('1');
    const store = join(root, 'store');
    const agents = agentWith(['xmtp', 'webhook']);
    const log = (line: string): void => {
      lines.push(line);
    };
    const first = prepareRuntime({ sources, store, agents, bun, log });
    expect(first).toEqual({ dir: store, entry: join(store, SERVER_ENTRY), trains: join(store, 'trains'), manifest: join(sources, 'stations.json') });
    expect(readFileSync(first.entry, 'utf8')).toContain("'1'");
    const pkg = JSON.parse(readFileSync(join(store, 'package.json'), 'utf8')) as { dependencies: Record<string, string> };
    expect(Object.keys(pkg.dependencies)).toEqual(['@xmtp/node-sdk', 'pino', 'viem', 'zod']);
    expect(installs()).toBe(1);
    expect(lines).toHaveLength(1);
    expect(prepareRuntime({ sources, store, agents, bun, log })).toEqual(first);
    expect(installs()).toBe(1);
  });

  test('a new metro version replaces the copied sources without reinstalling unchanged SDKs; a new channel installs', () => {
    const store = join(root, 'store');
    const agents = agentWith(['xmtp']);
    prepareRuntime({ sources: stageSources('1'), store, agents, bun });
    const next = prepareRuntime({ sources: stageSources('2'), store, agents, bun });
    expect(readFileSync(next.entry, 'utf8')).toContain("'2'");
    expect(installs()).toBe(1);
    prepareRuntime({ sources: stageSources('2'), store, agents: agentWith(['xmtp', 'whatsapp']), bun });
    expect(installs()).toBe(2);
    expect(JSON.parse(readFileSync(join(store, 'package.json'), 'utf8'))).toMatchObject({ dependencies: { baileys: '7.0.0-rc14' } });
  });

  test('a failed install throws and leaves no marker, so the next serve retries', () => {
    writeFileSync(bun, '#!/bin/sh\nexit 3\n');
    const store = join(root, 'store');
    mkdirSync(store, { recursive: true });
    expect(() => installDependencies(store, { pino: '^9' }, bun, () => undefined)).toThrow('exit 3');
    expect(existsSync(join(store, 'node_modules', '.metro-installed'))).toBe(false);
  });

  test('sources without a manifest run in place, the from-source layout', () => {
    const sources = join(root, 'repo');
    mkdirSync(sources, { recursive: true });
    expect(prepareRuntime({ sources, store: join(root, 'unused'), bun })).toEqual({
      dir: sources,
      entry: join(sources, SERVER_ENTRY),
      trains: join(sources, 'trains'),
      manifest: null,
    });
    expect(existsSync(join(root, 'unused'))).toBe(false);
  });
});
