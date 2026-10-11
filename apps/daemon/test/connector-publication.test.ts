import { afterEach, beforeEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { combineConnectorPolicies } from '@metro-labs/http/connector-delivery';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { answerPrompt, forgetAllPrompts, holdPrompt, pendingPrompts } from '../src/approvals/pending.ts';
import { blockedReason, connectorGates, connectorToolOf, type GateRow } from '../src/connectors/gates.ts';
import { pluginServers, serverKeysOf } from '../src/connectors/plugin-sync.ts';
import { publishConnectors, publishLocalConnectors, publishOrgConnectors } from '../src/connectors/publication.ts';
import { localImportConnectors, localRenameConnector, loadConnectorPolicies, readLocalConnectors } from '../src/connectors/store.ts';
import { watchPolicySnapshot } from '../src/mcp/policy-snapshot.ts';
import { localSessionApis } from '../src/routes/local-mode.ts';

const LOCAL = 'conn0000001';
const ORG = `org-${LOCAL}`;
const ORG_KEY = `org-local-${Buffer.from(LOCAL).toString('hex')}`;
const org: GateRow = { id: ORG, name: 'Local', config: { policy: { write: 'ask', tools: { 'read/path:thing': 'deny' } }, toolGroups: { read: 'read' } } };
let dir = '';
let plugin = '';
let stop = () => {};
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(['METRO_AGENTS_DIR', 'METRO_CLAUDE_DIR', 'METRO_RUNTIME_STORE'].map((key) => [key, process.env[key]]));
  dir = mkdtempSync(join(tmpdir(), 'metro-combined-connectors-'));
  process.env.METRO_AGENTS_DIR = join(dir, 'agents');
  process.env.METRO_CLAUDE_DIR = join(dir, 'claude');
  process.env.METRO_RUNTIME_STORE = join(dir, 'runtime');
  mkdirSync(process.env.METRO_AGENTS_DIR, { recursive: true });
  plugin = join(process.env.METRO_CLAUDE_DIR, 'plugins', 'metro');
  mkdirSync(join(plugin, 'bin'), { recursive: true });
  writeFileSync(join(plugin, 'bin', 'metro-plugin.mjs'), '');
  publishLocalConnectors([]); publishOrgConnectors([]); forgetAllPrompts();
  stop = watchPolicySnapshot();
  localImportConnectors([{ id: LOCAL, name: 'Local', url: 'https://local.example/mcp', config: { auth: { kind: 'header', name: 'Authorization', value: 'local-secret' } } }]);
  publishOrgConnectors([org]);
});

afterEach(() => {
  stop(); publishOrgConnectors([]); publishLocalConnectors([]); forgetAllPrompts();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  rmSync(dir, { recursive: true, force: true });
});

const servers = () => JSON.parse(readFileSync(join(plugin, '.mcp.json'), 'utf8')) as Record<string, { url: string }>;
const ids = () => connectorGates().map((gate) => gate.id);
const server = () => connectorGates().find((gate) => gate.id === ORG)?.server ?? '';
const apis = () => localSessionApis({
  syncStations: () => Promise.resolve(), reloadAgents: () => Promise.resolve(), restart: () => {}, stop: () => {},
  gatherAccounts: () => Promise.resolve({ accounts: {}, unavailable: [] }), capabilities: () => ({}), prepareAccount: () => Promise.reject(new Error('unused')),
});

test('local writes, page-list resync, boot policy load and plugin reinstall retain both sources', async () => {
  expect(ids()).toEqual([LOCAL, ORG]);
  expect(Object.keys(servers())).toEqual(['local', ORG_KEY]);
  await localRenameConnector(LOCAL, 'Renamed');
  expect(ids()).toEqual([LOCAL, ORG]);
  const list = await apis().connectorApi?.listConnectors();
  expect(list?.map((row) => row.id)).toEqual([LOCAL]);
  expect(ids()).toEqual([LOCAL, ORG]);
  await loadConnectorPolicies();
  writeFileSync(join(plugin, '.mcp.json'), '{}');
  publishLocalConnectors(readLocalConnectors());
  expect(Object.keys(servers())).toEqual(['renamed', ORG_KEY]);
  publishConnectors();
  expect(ids()).toEqual([LOCAL, ORG]);
});

test('org invalidation removes only its tools and leaves local disk byte-identical', () => {
  const path = join(dir, 'agents', 'connectors.json');
  const before = readFileSync(path, 'utf8');
  publishOrgConnectors([]);
  expect(ids()).toEqual([LOCAL]);
  expect(Object.keys(servers())).toEqual(['local']);
  expect(readFileSync(path, 'utf8')).toBe(before);
});

test('publication projects only names, ids, policy and groups, with no credential material', () => {
  const withSecrets = { ...org, url: 'https://secret.example/mcp?token=url-secret', revision: 'private-revision', headers: { Authorization: 'header-secret' }, config: { ...org.config, auth: { kind: 'header', value: 'config-secret' } } };
  publishOrgConnectors([withSecrets]);
  const pluginText = readFileSync(join(plugin, '.mcp.json'), 'utf8');
  const policyText = readFileSync(join(dir, 'agents', 'policy.json'), 'utf8');
  const localText = readFileSync(join(dir, 'agents', 'connectors.json'), 'utf8');
  for (const secret of ['url-secret', 'header-secret', 'config-secret', 'private-revision', 'secret.example']) {
    expect(pluginText + policyText + localText).not.toContain(secret);
  }
  expect(policyText).toContain('read/path:thing');
  expect(blockedReason(ORG, 'read/path:thing')).toContain('Blocked by');
  expect(servers()[server()]?.url).toEndWith(`/relay/${ORG}`);
});

test('equal ids/names and adversarial source-name collisions preserve local keys and unique org routes', () => {
  const rows = [
    { id: LOCAL, name: 'Local' },
    { id: 'conn0000002', name: ORG_KEY },
    { id: ORG, name: 'Local' },
    { id: 'org-CONN0000001', name: 'Local' },
  ];
  const keys = serverKeysOf(rows);
  expect(keys.get(LOCAL)).toBe('local');
  expect(keys.get('conn0000002')).toBe(ORG_KEY);
  expect(new Set(keys.values()).size).toBe(rows.length);
  const published = pluginServers(rows, 'http://127.0.0.1:8420');
  expect(new Set(Object.values(published).map((entry) => entry.url)).size).toBe(rows.length);
  expect(connectorToolOf(`mcp__plugin_metro_${server()}__read`)?.gate.id).toBe(ORG);
  expect(connectorToolOf('mcp__metro_box_Local__read')?.gate.id).toBe(LOCAL);
});

function hook(tool: string): string {
  const result = spawnSync('node', [join(import.meta.dir, '..', '..', '..', 'plugin', 'bin', 'guard.mjs')], {
    input: JSON.stringify({ tool_name: tool, tool_input: {}, agent_id: 'worker' }), encoding: 'utf8', env: process.env,
  });
  expect(result.status).toBe(0);
  if (result.stdout.trim() === '') return 'allow';
  return (JSON.parse(result.stdout) as { hookSpecificOutput: { permissionDecision: string } }).hookSpecificOutput.permissionDecision;
}

test('prototype tool names cannot weaken an assignment deny into approval in the daemon or hook', async () => {
  const policy = combineConnectorPolicies({ tools: { other: 'allow' } }, { write: 'deny' });
  publishOrgConnectors([{ ...org, config: { policy } }]);
  const name = `mcp__plugin_metro_${server()}__toString`;
  holdPrompt({ requestId: 'orgpe', tool: name, description: '', preview: '{}', line: undefined, at: Date.now() }, {}, () => Promise.resolve());
  await answerPrompt('orgpe', 'allow', 'chat');
  for (const tool of ['toString', 'valueOf', 'constructor', '__proto__']) {
    expect(blockedReason(ORG, tool)).toContain('Blocked by');
    expect(hook(`mcp__plugin_metro_${server()}__${tool}`)).toBe('deny');
  }
});

test('org ids containing delimiters cannot resolve to a shorter local server in daemon or hook', () => {
  const id = 'org-abc__123456';
  publishLocalConnectors([{ id: LOCAL, name: 'org-shared-abc', config: {} }]);
  publishOrgConnectors([{ id, name: 'Shared', config: { policy: { write: 'ask' } } }]);
  const key = connectorGates().find((gate) => gate.id === id)?.server ?? '';
  expect(key).not.toContain('__');
  const tool = `mcp__plugin_metro_${key}__write_item`;
  expect(connectorToolOf(tool)?.gate.id).toBe(id);
  expect(hook(tool)).toBe('ask');
  expect(connectorToolOf('mcp__metro_box_Shared__write_item')).toBeUndefined();
  expect(hook('mcp__metro_box_Shared__write_item')).toBe('allow');
});

test('first discovery preserves an approval when the tool keeps the same effective policy', async () => {
  const name = `mcp__plugin_metro_${server()}__write`;
  holdPrompt({ requestId: 'orgpd', tool: name, description: '', preview: '{}', line: undefined, at: Date.now() }, {}, () => Promise.resolve());
  await answerPrompt('orgpd', 'allow', 'chat');
  publishOrgConnectors([{ ...org, config: { ...org.config, toolGroups: { read: 'read', write: 'write' } } }]);
  expect(blockedReason(ORG, 'write')).toBeNull();
  expect(blockedReason(ORG, 'write')).toContain("Needs the owner's approval");
});

test('removing or restricting an org connector revokes prior grants and pending prompts', async () => {
  const name = `mcp__plugin_metro_${server()}__write`;
  holdPrompt({ requestId: 'orgpa', tool: name, description: '', preview: '{}', line: undefined, at: Date.now() }, {}, () => Promise.resolve());
  await answerPrompt('orgpa', 'allow', 'chat');
  holdPrompt({ requestId: 'orgpb', tool: name, description: '', preview: '{}', line: undefined, at: Date.now() }, {}, () => Promise.resolve());
  publishOrgConnectors([]);
  expect(pendingPrompts()).toEqual([]);
  publishOrgConnectors([org]);
  expect(blockedReason(ORG, 'write')).toContain("Needs the owner's approval");
  holdPrompt({ requestId: 'orgpc', tool: name, description: '', preview: '{}', line: undefined, at: Date.now() }, {}, () => Promise.resolve());
  await answerPrompt('orgpc', 'allow', 'chat');
  publishOrgConnectors([{ ...org, config: { ...org.config, policy: { write: 'deny' } } }]);
  publishOrgConnectors([org]);
  expect(blockedReason(ORG, 'write')).toContain("Needs the owner's approval");
});
