import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { log } from '@metro-labs/core/log';
import { adoptOrgServerKeys } from '../src/connectors/org-adopt.ts';
import { connectorGates } from '../src/connectors/gates.ts';
import { publishOrgConnectors } from '../src/connectors/publication.ts';

const OWNER = 'org_01AGENTOWNER00000';
let dir = '';
let saved: Record<string, string | undefined> = {};

const keysPath = () => join(dir, 'agents', 'connector-server-keys.json');
const markerPath = () => join(dir, 'agents', 'connector-server-keys.initialized');
const migrationsPath = () => join(dir, 'agents', 'connector-migrations.json');
const agents = () => join(dir, 'agents');

function record(sourceId: unknown, destinationId: unknown, phase: unknown = 'active'): Record<string, unknown> {
  return { id: 'oper0000001', owner: OWNER, agentId: 'agent000001', keyId: 'k'.repeat(43), sourceId, name: 'Linear', destinationId, phase, auth: 'oauth', sourceStamp: 's'.repeat(43), policy: {}, reason: null };
}

function writeMigrations(records: unknown[]): string {
  const text = `${JSON.stringify({ version: 1, records })}\n`;
  writeFileSync(migrationsPath(), text);
  writeFileSync(join(agents(), 'connector-migrations.initialized'), '1\n');
  return text;
}

function writeKeys(keys: Record<string, string>): void {
  writeFileSync(keysPath(), `${JSON.stringify({ version: 1, keys })}\n`);
  writeFileSync(markerPath(), '1\n');
}

const keys = (): Record<string, string> => (JSON.parse(readFileSync(keysPath(), 'utf8')) as { keys: Record<string, string> }).keys;

beforeEach(() => {
  saved = Object.fromEntries(['METRO_AGENTS_DIR', 'METRO_CLAUDE_DIR', 'METRO_RUNTIME_STORE'].map((key) => [key, process.env[key]]));
  dir = mkdtempSync(join(tmpdir(), 'metro-org-adopt-'));
  mkdirSync(agents(), { recursive: true });
  process.env.METRO_AGENTS_DIR = agents();
  process.env.METRO_CLAUDE_DIR = join(dir, 'claude');
  delete process.env.METRO_RUNTIME_STORE;
});

afterEach(() => {
  publishOrgConnectors([]);
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  rmSync(dir, { recursive: true, force: true });
});

test('an active migration moves its server key to the organization id and leaves the old files alone', () => {
  const migrations = writeMigrations([record('conn0000001', 'dest0000001')]);
  const local = '{"version":1,"connectors":[{"id":"conn0000001","name":"Linear"}]}\n';
  writeFileSync(join(agents(), 'connectors.json'), local);
  writeKeys({ conn0000001: 'linear', other000001: 'jira' });
  expect(adoptOrgServerKeys(agents())).toBe(1);
  expect(keys()).toEqual({ other000001: 'jira', 'org-dest0000001': 'linear' });
  expect(statSync(keysPath()).mode & 0o777).toBe(0o600);
  expect(readFileSync(markerPath(), 'utf8')).toBe('1\n');
  expect(readFileSync(migrationsPath(), 'utf8')).toBe(migrations);
  expect(readFileSync(join(agents(), 'connectors.json'), 'utf8')).toBe(local);
});

test('a second run changes nothing', () => {
  writeMigrations([record('conn0000001', 'dest0000001')]);
  writeKeys({ conn0000001: 'linear' });
  expect(adoptOrgServerKeys(agents())).toBe(1);
  const after = readFileSync(keysPath(), 'utf8');
  expect(adoptOrgServerKeys(agents())).toBe(0);
  expect(readFileSync(keysPath(), 'utf8')).toBe(after);
});

test('no migration file, or no server keys and marker, is a no-op that creates nothing', () => {
  writeKeys({ conn0000001: 'linear' });
  const before = readFileSync(keysPath(), 'utf8');
  expect(adoptOrgServerKeys(agents())).toBe(0);
  expect(readFileSync(keysPath(), 'utf8')).toBe(before);
  rmSync(keysPath());
  rmSync(markerPath());
  writeMigrations([record('conn0000001', 'dest0000001')]);
  expect(adoptOrgServerKeys(agents())).toBe(0);
  expect(existsSync(keysPath())).toBe(false);
  expect(existsSync(markerPath())).toBe(false);
});

test('records that are not an active migration with a valid destination are ignored', () => {
  writeMigrations([
    record('conn0000001', 'dest0000001', 'prepared'),
    record('conn0000002', 'dest0000002', 'rolled_back'),
    record('conn0000003', null),
    record(42, 'dest0000004'),
    record('conn0000005', 'not an id!'),
    'garbage',
    null,
  ]);
  writeKeys({ conn0000001: 'a', conn0000002: 'b', conn0000003: 'c', conn0000005: 'e' });
  const before = readFileSync(keysPath(), 'utf8');
  expect(adoptOrgServerKeys(agents())).toBe(0);
  expect(readFileSync(keysPath(), 'utf8')).toBe(before);
});

test('two aliases with distinct keys both move, and a destination that already has a key keeps it', () => {
  writeMigrations([record('conn0000001', 'dest0000001'), record('conn0000002', 'dest0000002'), record('conn0000003', 'dest0000003')]);
  writeKeys({ conn0000001: 'linear', conn0000002: 'jira', conn0000003: 'notion', 'org-dest0000003': 'notion-1' });
  expect(adoptOrgServerKeys(agents())).toBe(2);
  expect(keys()).toEqual({ conn0000003: 'notion', 'org-dest0000003': 'notion-1', 'org-dest0000001': 'linear', 'org-dest0000002': 'jira' });
});

test('an unreadable migration file or invalid server keys are logged and never thrown', () => {
  const warn = spyOn(log, 'warn');
  try {
    writeKeys({ conn0000001: 'linear' });
    writeFileSync(migrationsPath(), '{bad');
    expect(adoptOrgServerKeys(agents())).toBe(0);
    writeFileSync(migrationsPath(), JSON.stringify({ version: 2, records: [record('conn0000001', 'dest0000001')] }));
    expect(adoptOrgServerKeys(agents())).toBe(0);
    expect(keys()).toEqual({ conn0000001: 'linear' });
    writeMigrations([record('conn0000001', 'dest0000001')]);
    rmSync(markerPath());
    expect(adoptOrgServerKeys(agents())).toBe(0);
    expect(keys()).toEqual({ conn0000001: 'linear' });
    expect(warn.mock.calls.length).toBe(3);
  } finally {
    warn.mockRestore();
    writeFileSync(markerPath(), '1\n');
  }
});

test('after the switch the organization connector is published under its old server key, so tool names stay', () => {
  const plugin = join(dir, 'claude', 'plugins', 'metro');
  mkdirSync(join(plugin, 'bin'), { recursive: true });
  writeFileSync(join(plugin, 'bin', 'metro-plugin.mjs'), '');
  writeFileSync(join(plugin, '.mcp.json'), JSON.stringify({ linear: { type: 'http', url: 'http://127.0.0.1:8420/relay/conn0000001' } }));
  writeMigrations([record('conn0000001', 'dest0000001')]);
  writeKeys({ conn0000001: 'linear' });
  adoptOrgServerKeys(agents());
  publishOrgConnectors([{ id: 'org-dest0000001', name: 'Linear (organization)', config: {} }]);
  const servers = JSON.parse(readFileSync(join(plugin, '.mcp.json'), 'utf8')) as Record<string, { url: string }>;
  expect(Object.keys(servers)).toEqual(['linear']);
  expect(servers.linear?.url).toEndWith('/relay/org-dest0000001');
  expect(connectorGates().map((gate) => [gate.id, gate.server])).toEqual([['org-dest0000001', 'linear']]);
});
