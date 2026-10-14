import { afterEach, beforeEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SOURCE = 'conn0000001';
const DESTINATION = 'dest0000001';
const ENV = ['METRO_AGENTS_DIR', 'METRO_CLAUDE_DIR', 'METRO_RUNTIME_STORE'] as const;
let dir = '';
let plugin = '';
let saved: Record<string, string | undefined> = {};

const SCRIPT = `
import { adoptOrgServerKeys } from '${join(import.meta.dir, '../src/connectors/org-adopt.ts')}';
import { connectorsReady, publishConnectors, publishOrgConnectors } from '${join(import.meta.dir, '../src/connectors/publication.ts')}';
const step = process.argv.at(-1);
adoptOrgServerKeys();
publishConnectors();
process.stdout.write(\`ready before delivery: \${String(connectorsReady())}, after 30 s: \${String(connectorsReady(Date.now() + 30_000))}\\n\`);
if (step === 'delivered') publishOrgConnectors([{ id: 'org-${DESTINATION}', name: 'Renamed in the organization', config: {} }]);
process.stdout.write(\`ready at the end: \${String(connectorsReady())}\\n\`);
`;

const run = (step: string) => spawnSync(process.execPath, ['-e', SCRIPT, step], { env: process.env, encoding: 'utf8' });
const servers = () => JSON.parse(readFileSync(join(plugin, '.mcp.json'), 'utf8')) as Record<string, { url: string }>;

beforeEach(() => {
  saved = Object.fromEntries(ENV.map((key) => [key, process.env[key]]));
  dir = mkdtempSync(join(tmpdir(), 'metro-publication-boot-'));
  const agents = join(dir, 'agents');
  process.env.METRO_AGENTS_DIR = agents;
  process.env.METRO_CLAUDE_DIR = join(dir, 'claude');
  process.env.METRO_RUNTIME_STORE = join(dir, 'runtime');
  mkdirSync(agents, { recursive: true });
  plugin = join(process.env.METRO_CLAUDE_DIR, 'plugins', 'metro');
  mkdirSync(join(plugin, 'bin'), { recursive: true });
  writeFileSync(join(plugin, 'bin', 'metro-plugin.mjs'), '');
  writeFileSync(join(plugin, '.mcp.json'), JSON.stringify({ 'local-mcp': { type: 'http', url: `http://127.0.0.1:8420/relay/${SOURCE}` } }));
  writeFileSync(join(agents, 'connector-migrations.json'), JSON.stringify({ version: 1, records: [{ sourceId: SOURCE, destinationId: DESTINATION, name: 'Local MCP', phase: 'active' }] }));
  writeFileSync(join(agents, 'connector-server-keys.json'), JSON.stringify({ version: 1, keys: { [SOURCE]: 'local-mcp' } }));
  writeFileSync(join(agents, 'connector-server-keys.initialized'), '1\n');
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  rmSync(dir, { recursive: true, force: true });
});

test('a fresh daemon keeps the last list until its first organization delivery, then serves the same server key at the organization id', () => {
  const boot = run('boot');
  expect(boot.status).toBe(0);
  expect(boot.stdout).toContain('ready before delivery: false, after 30 s: true');
  expect(boot.stdout).toContain('ready at the end: false');
  expect(servers()).toEqual({ 'local-mcp': { type: 'http', url: `http://127.0.0.1:8420/relay/${SOURCE}` } });
  const delivered = run('delivered');
  expect(delivered.status).toBe(0);
  expect(delivered.stdout).toContain('ready at the end: true');
  expect(Object.keys(servers())).toEqual(['local-mcp']);
  expect(servers()['local-mcp']?.url).toEndWith(`/relay/org-${DESTINATION}`);
});
