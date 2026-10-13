import { afterEach, beforeEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migration, SOURCE, SOURCE_NAME } from './migration-guard-fixture.ts';

let dir = '';
let plugin = '';

const SCRIPT = `
import { publishLocalConnectors, publishOrgConnectors } from '${join(import.meta.dir, '../src/connectors/publication.ts')}';
const step = process.argv.at(-1);
publishLocalConnectors([{ id: '${SOURCE}', name: '${SOURCE_NAME}', config: {} }]);
if (step === 'delivered') publishOrgConnectors([{ id: '${SOURCE}', name: '${SOURCE_NAME}', config: {} }]);
`;

const run = (step: string) => spawnSync(process.execPath, ['-e', SCRIPT, step], { env: process.env, encoding: 'utf8' });
const servers = () => Object.keys(JSON.parse(readFileSync(join(plugin, '.mcp.json'), 'utf8')) as Record<string, unknown>);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'metro-publication-boot-'));
  process.env.METRO_AGENTS_DIR = join(dir, 'agents');
  process.env.METRO_CLAUDE_DIR = join(dir, 'claude');
  process.env.METRO_RUNTIME_STORE = join(dir, 'runtime');
  mkdirSync(process.env.METRO_AGENTS_DIR, { recursive: true });
  plugin = join(process.env.METRO_CLAUDE_DIR, 'plugins', 'metro');
  mkdirSync(join(plugin, 'bin'), { recursive: true });
  writeFileSync(join(plugin, 'bin', 'metro-plugin.mjs'), '');
  writeFileSync(join(plugin, '.mcp.json'), JSON.stringify({ 'local-mcp': { type: 'http', url: `http://127.0.0.1:8420/relay/${SOURCE}` } }));
  migration(process.env.METRO_AGENTS_DIR, 'active');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test('a fresh daemon with migrated connectors keeps the last list until its first organization delivery', () => {
  expect(run('boot').status).toBe(0);
  expect(servers()).toEqual(['local-mcp']);
  expect(run('delivered').status).toBe(0);
  expect(servers()).toEqual(['local-mcp']);
});
