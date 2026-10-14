import { afterEach, beforeEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { close, listen } from './org-sync-control-fixture.ts';
import { handleRelayRequest } from '../src/connectors/relay.ts';
import { promptBody } from '../src/mcp/permission-prompt.ts';
import { combineConnectorPolicies } from '@metro-labs/http/connector-delivery';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { answerPrompt, forgetAllPrompts, holdPrompt, pendingPrompts } from '../src/approvals/pending.ts';
import { blockedReason, connectorGates, connectorToolOf, requestConnectorBlocker, type GateRow } from '../src/connectors/gates.ts';
import { pluginServers, serverKeysOf } from '../src/connectors/plugin-sync.ts';
import { publishConnectors, publishOrgConnectors } from '../src/connectors/publication.ts';
import { watchPolicySnapshot } from '../src/mcp/policy-snapshot.ts';

const ORG = 'org-conn0000001';
const org: GateRow = { id: ORG, name: 'Local', config: { policy: { write: 'ask', tools: { 'read/path:thing': 'deny' } }, toolGroups: { read: 'read' } } };
let dir = '';
let plugin = '';
let stop = () => {};
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(['METRO_AGENTS_DIR', 'METRO_CLAUDE_DIR', 'METRO_RUNTIME_STORE'].map((key) => [key, process.env[key]]));
  dir = mkdtempSync(join(tmpdir(), 'metro-org-connectors-'));
  process.env.METRO_AGENTS_DIR = join(dir, 'agents');
  process.env.METRO_CLAUDE_DIR = join(dir, 'claude');
  process.env.METRO_RUNTIME_STORE = join(dir, 'runtime');
  mkdirSync(process.env.METRO_AGENTS_DIR, { recursive: true });
  plugin = join(process.env.METRO_CLAUDE_DIR, 'plugins', 'metro');
  mkdirSync(join(plugin, 'bin'), { recursive: true });
  writeFileSync(join(plugin, 'bin', 'metro-plugin.mjs'), '');
  publishOrgConnectors([]); forgetAllPrompts();
  stop = watchPolicySnapshot();
  publishOrgConnectors([org]);
});

afterEach(() => {
  stop(); publishOrgConnectors([]); forgetAllPrompts();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  rmSync(dir, { recursive: true, force: true });
});

const servers = () => JSON.parse(readFileSync(join(plugin, '.mcp.json'), 'utf8')) as Record<string, { url: string }>;
const ids = () => connectorGates().map((gate) => gate.id);
const server = () => connectorGates().find((gate) => gate.id === ORG)?.server ?? '';
const keysFile = () => join(dir, 'agents', 'connector-server-keys.json');
const savedKeys = () => (JSON.parse(readFileSync(keysFile(), 'utf8')) as { keys: Record<string, string> }).keys;

test('organization rows become plugin servers by their plain name, and a plugin reinstall gets them back', () => {
  expect(ids()).toEqual([ORG]);
  expect(Object.keys(servers())).toEqual(['local']);
  expect(servers().local?.url).toEndWith(`/relay/${ORG}`);
  writeFileSync(join(plugin, '.mcp.json'), '{}');
  publishConnectors();
  expect(Object.keys(servers())).toEqual(['local']);
});

test('an empty delivery removes every server', () => {
  publishOrgConnectors([]);
  expect(ids()).toEqual([]);
  expect(servers()).toEqual({});
});

test('server keys are saved at 0600 and saved keys win over a rename or a new connector with the same name', () => {
  expect(savedKeys()).toEqual({ [ORG]: 'local' });
  expect(statSync(keysFile()).mode & 0o777).toBe(0o600);
  expect(readFileSync(join(dir, 'agents', 'connector-server-keys.initialized'), 'utf8')).toBe('1\n');
  publishOrgConnectors([{ ...org, name: 'Renamed' }, { id: 'org-conn0000002', name: 'Local', config: {} }]);
  expect(savedKeys()).toEqual({ [ORG]: 'local', 'org-conn0000002': 'local-1' });
  expect(Object.keys(servers()).sort()).toEqual(['local', 'local-1']);
  publishOrgConnectors([{ id: 'org-conn0000002', name: 'Local', config: {} }]);
  expect(Object.keys(servers())).toEqual(['local-1']);
  expect(savedKeys()).toEqual({ [ORG]: 'local', 'org-conn0000002': 'local-1' });
});

test('saved keys win, and the keys file is rewritten only when the map changed', () => {
  writeFileSync(keysFile(), `${JSON.stringify({ version: 1, keys: { 'org-gone0000001': 'local' } })}\n`);
  publishOrgConnectors([]);
  publishOrgConnectors([org]);
  expect(savedKeys()).toEqual({ 'org-gone0000001': 'local', [ORG]: 'local-1' });
  const kept = `${JSON.stringify({ version: 1, keys: { [ORG]: 'kept-key' } })}\n`;
  writeFileSync(keysFile(), kept);
  publishConnectors();
  expect(server()).toBe('kept-key');
  expect(readFileSync(keysFile(), 'utf8')).toBe(kept);
});

test('publication projects only names, ids, policy and groups, with no credential material', () => {
  const withSecrets = { ...org, url: 'https://secret.example/mcp?token=url-secret', revision: 'private-revision', headers: { Authorization: 'header-secret' }, config: { ...org.config, auth: { kind: 'header', value: 'config-secret' } } };
  publishOrgConnectors([withSecrets]);
  const pluginText = readFileSync(join(plugin, '.mcp.json'), 'utf8');
  const policyText = readFileSync(join(dir, 'agents', 'policy.json'), 'utf8');
  for (const secret of ['url-secret', 'header-secret', 'config-secret', 'private-revision', 'secret.example']) {
    expect(pluginText + policyText).not.toContain(secret);
  }
  expect(policyText).toContain('read/path:thing');
  expect(blockedReason(ORG, 'read/path:thing')).toContain('Blocked by');
  expect(servers()[server()]?.url).toEndWith(`/relay/${ORG}`);
});

test('equal names and adversarial name collisions keep unique keys and unique routes', () => {
  const rows = [
    { id: 'org-conn0000002', name: 'local-1' },
    { id: ORG, name: 'Local' },
    { id: 'org-CONN0000001', name: 'Local' },
  ];
  const keys = serverKeysOf(rows);
  expect(new Set(keys.values()).size).toBe(rows.length);
  const published = pluginServers(rows, 'http://127.0.0.1:8420');
  expect(new Set(Object.values(published).map((entry) => entry.url)).size).toBe(rows.length);
  expect(connectorToolOf(`mcp__plugin_metro_${server()}__read`)?.gate.id).toBe(ORG);
  expect(connectorToolOf('mcp__metro_box_Local__read')).toBeUndefined();
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

test('org ids containing delimiters still resolve to their own server in daemon and hook', () => {
  const id = 'org-abc__123456';
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

test('corrupt server keys close relay calls before the vendor', async () => {
  let reached = 0;
  const vendor = createServer((req, res) => { reached += 1; req.resume(); res.writeHead(200).end('{}'); });
  const upstream = await listen(vendor);
  const target = () => ({ kind: 'ok' as const, url: upstream, headers: { Authorization: 'header-fixture' } });
  const relay = createServer((req, res) => {
    handleRelayRequest(req, res, {
      identify: () => ({ subject: 'fixture', agentId: 'agent000001' }),
      open: () => ({ target: () => Promise.resolve(target()), current: target, blocker: requestConnectorBlocker(), signal: new AbortController().signal, close: () => undefined }),
    });
  });
  const base = await listen(relay);
  const before = readFileSync(keysFile(), 'utf8');
  try {
    publishOrgConnectors([{ ...org, config: { policy: { write: 'deny' } } }]);
    writeFileSync(keysFile(), '{bad');
    expect(() => publishConnectors()).toThrow();
    expect(connectorGates()).toHaveLength(0);
    const result = await fetch(`${base}/relay/${ORG}`, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'write', arguments: {} } }) });
    expect(await result.json()).toMatchObject({ result: { isError: true, content: [{ text: 'This organization connector is not available.' }] } });
    expect(reached).toBe(0);
  } finally {
    writeFileSync(keysFile(), before);
    await close(relay); await close(vendor);
  }
});

test('same-name connectors never share policies or approval grants', async () => {
  const first: GateRow = { id: ORG, name: 'Local', config: { policy: { write: 'ask' } } };
  const second: GateRow = { id: 'org-conn0000002', name: 'Local', config: { policy: { write: 'ask' } } };
  publishOrgConnectors([first, second]);
  const firstKey = connectorGates().find((gate) => gate.id === first.id)?.server ?? '';
  const secondKey = connectorGates().find((gate) => gate.id === second.id)?.server ?? '';
  expect(firstKey).not.toBe(secondKey);
  for (const [id, key] of [[first.id, firstKey], [second.id, secondKey]]) {
    const body = promptBody({ request_id: 'abcde', tool_name: `mcp__plugin_metro_${key}__write`, description: 'private-endpoint-secret', input_preview: '{}' });
    expect(body).toContain(`Connector: Local (${id})`);
    expect(body).not.toContain('private-endpoint-secret');
  }
  expect(hook(`mcp__plugin_metro_${firstKey}__write`)).toBe('ask');
  holdPrompt({ requestId: 'dupab', tool: `mcp__plugin_metro_${firstKey}__write`, description: '', preview: '{}', line: undefined, at: Date.now() }, {}, () => Promise.resolve());
  await answerPrompt('dupab', 'allow', 'page');
  expect(blockedReason(second.id, 'write')).toContain("Needs the owner's approval");
  expect(blockedReason(first.id, 'write')).toBeNull();
  publishOrgConnectors([second]);
  expect(blockedReason(second.id, 'write')).toContain("Needs the owner's approval");
  expect(connectorGates()[0]?.server).toBe(secondKey);
  publishOrgConnectors([{ ...second, config: { policy: { write: 'deny' } } }, first]);
  expect(hook(`mcp__plugin_metro_${secondKey}__write`)).toBe('deny');
  expect(hook(`mcp__plugin_metro_${firstKey}__write`)).toBe('ask');
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
