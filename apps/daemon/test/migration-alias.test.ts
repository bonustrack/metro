import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localMigrationIdle, migrationRuntimeMapping, type MigrationRuntimeMapping } from '../src/connectors/migration-guard.ts';
import { migrationUncertaintyReceipt } from '../src/connectors/migration-operations.ts';
import { connectorGates, blockedReason } from '../src/connectors/gates.ts';
import { publishConnectors, publishLocalConnectors, publishOrgConnectors } from '../src/connectors/publication.ts';
import { answerPrompt, forgetAllPrompts, holdPrompt } from '../src/approvals/pending.ts';
import { enrolledKey, expectStatus, runtimeFixture, RELAY_ID, type RuntimeFixture } from './org-runtime-fixture.ts';
import { SyncControlFixture } from './org-sync-control-fixture.ts';
import { migration, SOURCE, SOURCE_NAME } from './migration-guard-fixture.ts';

let fixture: RuntimeFixture;
let dir = '';
let priorDir: string | undefined;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'metro-migration-alias-'));
  priorDir = process.env.METRO_AGENTS_DIR;
  process.env.METRO_AGENTS_DIR = dir;
  let mapping: () => MigrationRuntimeMapping = () => ({ aliases: [], reserved: [] });
  fixture = await runtimeFixture(() => mapping());
  mapping = () => migrationRuntimeMapping(fixture.state.owner, fixture.state.key, dir);
  fixture.state.live = false;
  migration(dir, 'active', { keyId: fixture.state.key.keyId });
  fixture.runtime.refresh();
});

afterEach(() => {
  fixture.close();
  publishOrgConnectors([]); publishLocalConnectors([]); forgetAllPrompts();
  if (priorDir === undefined) delete process.env.METRO_AGENTS_DIR;
  else process.env.METRO_AGENTS_DIR = priorDir;
  rmSync(dir, { recursive: true, force: true });
});

test('only the explicit alias runs with LIVE off and the destination never has a second relay key', async () => {
  expect(fixture.publications.at(-1)?.map((row) => [row.id, row.name])).toEqual([[SOURCE, SOURCE_NAME]]);
  const session = fixture.runtime.open(SOURCE);
  try {
    expect((await session.target(false)).kind).toBe('ok');
    expect(session.blocker()(SOURCE, 'write_item', {})).toContain('Blocked by');
    expect(session.blocker()(SOURCE, 'read_item', {})).toBeNull();
    expect(fixture.vendors.length).toBeGreaterThan(0);
    await expectStatus(() => fixture.runtime.open(RELAY_ID), 404);
    await expectStatus(() => fixture.runtime.open('local000002'), 404);
    fixture.state.live = true;
    await expectStatus(() => fixture.runtime.open(RELAY_ID), 404);
  } finally { session.close(); }
});

test('alias discovery drains a successful session DELETE with a body without uncertainty', async () => {
  fixture.state.vendor = (call) => Promise.resolve(call.method === 'DELETE' ? Response.json({ closed: true }) : null);
  const session = fixture.runtime.open(SOURCE);
  try {
    expect((await session.target(false)).kind).toBe('ok');
    expect(fixture.vendors.some((call) => call.method === 'DELETE')).toBe(true);
    expect(migrationUncertaintyReceipt(SOURCE, dir)).toBeNull();
  } finally { session.close(); }
  expect(localMigrationIdle(SOURCE, dir)).toBe(true);
});

test('current owner, enrollment and key are rechecked rather than captured at activation', async () => {
  for (const change of ['owner', 'enrollment', 'key'] as const) {
    const original = fixture.state.key;
    fixture.state.owner = 'org_01AGENTOWNER00000';
    fixture.state.key = enrolledKey();
    migration(dir, 'active', { keyId: fixture.state.key.keyId });
    await fixture.sync.sync();
    const session = fixture.runtime.open(SOURCE);
    if (change === 'owner') fixture.state.owner = 'org_other';
    if (change === 'key') fixture.state.key = enrolledKey();
    if (change === 'enrollment') fixture.state.key = { ...fixture.state.key, enrollment: { ...fixture.state.key.enrollment, server: 'agent000002' } };
    await expectStatus(() => session.current(), 503);
    expect(fixture.publications.at(-1)).toEqual([]);
    await expectStatus(() => fixture.runtime.open(SOURCE), 503);
    session.close();
    fixture.state.key = original;
  }
});

test('rollback fences new alias calls but waits for existing transports to close naturally', async () => {
  const session = fixture.runtime.open(SOURCE);
  await session.target(false);
  expect(fixture.runtime.idle(SOURCE)).toBe(false);
  migration(dir, 'rollback', { keyId: fixture.state.key.keyId });
  fixture.runtime.refresh();
  expect(fixture.publications.at(-1)).toEqual([]);
  expect(session.signal.aborted).toBe(false);
  expect(fixture.runtime.idle(SOURCE)).toBe(false);
  expect(fixture.runtime.idle('local000002')).toBe(true);
  await expectStatus(() => session.current(), 503);
  await expectStatus(() => fixture.runtime.open(SOURCE), 503);
  session.close();
  expect(fixture.runtime.idle(SOURCE)).toBe(true);
});

test('retiring one alias leaves an unrelated live organization stream available', async () => {
  fixture.state.live = true;
  const first = fixture.state.rows[0];
  if (first === undefined) throw new Error('missing fixture connector');
  fixture.state.rows.push({ ...first, id: 'conn0000002', name: 'Unrelated' });
  await fixture.sync.sync();
  const alias = fixture.runtime.open(SOURCE);
  const unrelated = fixture.runtime.open('org-conn0000002');
  migration(dir, 'rollback', { keyId: fixture.state.key.keyId });
  fixture.runtime.refresh();
  expect(unrelated.signal.aborted).toBe(false);
  expect(unrelated.current().kind).toBe('ok');
  expect(fixture.runtime.idle(SOURCE)).toBe(false);
  alias.close();
  expect(fixture.runtime.idle(SOURCE)).toBe(true);
  expect(fixture.runtime.idle()).toBe(false);
  unrelated.close();
});

test('malformed mapping drops runtime publication and never exposes a local credential', async () => {
  const session = fixture.runtime.open(SOURCE);
  const path = join(dir, 'connector-migrations.json');
  const original = readFileSync(path, 'utf8');
  writeFileSync(path, '{bad');
  await expectStatus(() => session.current(), 503);
  expect(fixture.publications.at(-1)).toEqual([]);
  await expectStatus(() => fixture.runtime.open(SOURCE), 503);
  session.close();
  writeFileSync(path, original);
});

test('publication replaces the source in place, preserving colliding plugin names and revoking changed policies', async () => {
  const source = { id: SOURCE, name: SOURCE_NAME, config: { policy: { write: 'ask' as const } } };
  const neighbor = { id: 'local000002', name: 'Local-MCP', config: {} };
  migration(dir, 'rolled_back', { keyId: fixture.state.key.keyId });
  publishOrgConnectors([]); publishLocalConnectors([neighbor, source]);
  const key = connectorGates().find((gate) => gate.id === SOURCE)?.server;
  expect(key).toBe('local-mcp-loca');
  migration(dir, 'cutover', { keyId: fixture.state.key.keyId });
  publishConnectors();
  expect(connectorGates().map((gate) => gate.id)).toEqual([neighbor.id]);
  migration(dir, 'active', { keyId: fixture.state.key.keyId });
  publishOrgConnectors([source, { id: RELAY_ID, name: SOURCE_NAME, config: {} }]);
  expect(connectorGates().map((gate) => gate.id)).toEqual([neighbor.id, SOURCE]);
  expect(connectorGates().find((gate) => gate.id === SOURCE)?.server).toBe(key);
  const tool = `mcp__plugin_metro_${key ?? ''}__write_item`;
  holdPrompt({ requestId: 'alsaa', tool, description: '', preview: '{}', line: undefined, at: Date.now() }, {}, () => Promise.resolve());
  await answerPrompt('alsaa', 'allow', 'chat');
  publishOrgConnectors([{ ...source, config: { ...source.config, toolGroups: { write_item: 'write' } } }]);
  expect(blockedReason(SOURCE, 'write_item')).toBeNull();
  holdPrompt({ requestId: 'alsab', tool, description: '', preview: '{}', line: undefined, at: Date.now() }, {}, () => Promise.resolve());
  await answerPrompt('alsab', 'allow', 'chat');
  publishOrgConnectors([{ ...source, config: { policy: { write: 'deny' } } }]);
  publishOrgConnectors([source]);
  expect(blockedReason(SOURCE, 'write_item')).toContain('Needs the owner');
  publishOrgConnectors([]);
  expect(connectorGates().map((gate) => gate.id)).toEqual([neighbor.id]);
});

test('a hidden first collision never changes the second local or alias plugin binding', () => {
  const previous = process.env.METRO_CLAUDE_DIR;
  const plugin = join(dir, 'claude', 'plugins', 'metro');
  process.env.METRO_CLAUDE_DIR = join(dir, 'claude');
  mkdirSync(join(plugin, 'bin'), { recursive: true });
  writeFileSync(join(plugin, 'bin', 'metro-plugin.mjs'), '');
  const first = { id: SOURCE, name: 'Foo Bar', config: {} };
  const second = { id: 'second00001', name: 'Foo.Bar', config: {} };
  const binding = () => connectorGates().find((gate) => gate.id === second.id)?.server;
  const servers = () => JSON.parse(readFileSync(join(plugin, '.mcp.json'), 'utf8')) as Record<string, { url: string }>;
  try {
    for (const secondPhase of ['rolled_back', 'active'] as const) {
      migration(dir, 'rolled_back', { name: first.name, keyId: fixture.state.key.keyId });
      migration(dir, secondPhase, { id: 'migrate0002', sourceId: second.id, name: second.name, destinationId: 'conn0000002', keyId: fixture.state.key.keyId });
      const secondAlias = secondPhase === 'active' ? [second] : [];
      publishLocalConnectors([first, second]);
      publishOrgConnectors(secondAlias);
      expect(binding()).toBe('foo-bar-seco');
      expect(servers()['foo-bar']?.url).toEndWith(`/relay/${first.id}`);
      for (const phase of ['cutover', 'active', 'rollback'] as const) {
        migration(dir, phase, { name: first.name, keyId: fixture.state.key.keyId });
        publishOrgConnectors(secondAlias);
        expect(binding()).toBe('foo-bar-seco');
        expect(Object.keys(servers())).toEqual(['foo-bar-seco']);
        expect(servers()['foo-bar-seco']?.url).toEndWith(`/relay/${second.id}`);
        expect(connectorGates().find((gate) => gate.server === 'foo-bar')).toBeUndefined();
      }
      migration(dir, 'active', { name: first.name, keyId: fixture.state.key.keyId });
      publishOrgConnectors([first, ...secondAlias]);
      expect(binding()).toBe('foo-bar-seco');
      expect(servers()['foo-bar']?.url).toEndWith(`/relay/${first.id}`);
    }
  } finally {
    if (previous === undefined) delete process.env.METRO_CLAUDE_DIR;
    else process.env.METRO_CLAUDE_DIR = previous;
  }
});

test('fresh migration snapshots use the current control with no env switch and Off never resumes a retired source', async () => {
  const control = await SyncControlFixture.create();
  try {
    await expect(control.control.fresh()).rejects.toThrow('Enable');
    control.control.set(true, control.control.status().scope);
    const before = control.calls.length;
    const snapshot = await control.control.fresh();
    expect(snapshot.connectors).toHaveLength(2);
    expect(control.calls.length).toBeGreaterThan(before);
    expect(process.env.METRO_CONNECTORS_LIVE_ENABLED).toBeUndefined();
    migration(control.dir, 'active', { keyId: control.key?.keyId ?? '' });
    control.control.refreshRuntime();
    const session = await control.control.open(SOURCE);
    expect(control.control.migrationIdle(SOURCE)).toBe(false);
    control.control.set(false, control.control.status().scope);
    expect(control.control.migrationIdle(SOURCE)).toBe(false);
    await expect(control.control.open(SOURCE)).rejects.toThrow('not available');
    session.close();
    expect(control.control.migrationIdle(SOURCE)).toBe(true);
  } finally { await control.cleanup(); }
});
