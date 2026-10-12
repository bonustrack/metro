import { afterEach, beforeEach, expect, test } from 'bun:test';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { close, listen } from './org-sync-control-fixture.ts';
import { localCreateConnector, localDeleteConnector, localDisconnectConnector, localImportConnectors, localReconnectConnector, localRelayTarget, localRenameConnector, localSetConnectorPolicy, readLocalConnectors } from '../src/connectors/store.ts';
import { blockedReason, connectorToolOf, registerConnectors } from '../src/connectors/gates.ts';
import { pluginServers, serverKeysOf } from '../src/connectors/plugin-sync.ts';
import { persistentServerKeys } from '../src/connectors/server-keys.ts';
import { readConfig } from '../src/connectors/config.ts';
import { copyConnectorRows } from '../src/connectors/transfer-store.ts';

let dir = '';
let base = '';
const seen: string[] = [];
const server = createServer((req, res) => {
  seen.push(req.headers.authorization ?? '');
  req.resume();
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ result: { protocolVersion: '2025-11-25', serverInfo: { name: 'fixture' }, tools: [{ name: 'read', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }] } }));
});
const input = (value: string) => ({ name: 'Identical', url: `${base}/mcp?key=private-fixture`, header: 'Authorization', value, clientId: undefined, clientSecret: undefined });

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'metro-connector-instances-'));
  seen.length = 0;
  base = await listen(server);
});
afterEach(async () => {
  registerConnectors([]);
  await close(server);
  rmSync(dir, { recursive: true, force: true });
});

test('identical labels and endpoints keep independent IDs, credentials, policies and tool namespaces', async () => {
  const first = await localCreateConnector(input('Bearer first-fixture'), dir);
  const second = await localCreateConnector(input('Bearer second-fixture'), dir);
  expect(first.id).not.toBe(second.id);
  expect(first.name).toBe(second.name);
  expect(first.url).toBe(second.url);
  await localSetConnectorPolicy(first.id, { read: 'deny', write: 'ask' }, dir);
  await localSetConnectorPolicy(second.id, { read: 'allow', write: 'deny' }, dir);
  expect(await localRelayTarget(first.id, false, dir)).toMatchObject({ headers: { Authorization: 'Bearer first-fixture' } });
  expect(await localRelayTarget(second.id, false, dir)).toMatchObject({ headers: { Authorization: 'Bearer second-fixture' } });
  expect(seen).toContain('Bearer first-fixture');
  expect(seen).toContain('Bearer second-fixture');
  const rows = readLocalConnectors(dir);
  const keys = persistentServerKeys(rows, dir);
  registerConnectors(rows, keys);
  const one = keys.get(first.id) ?? '';
  const two = keys.get(second.id) ?? '';
  expect(one).not.toBe(two);
  expect(connectorToolOf(`mcp__plugin_metro_${one}__read`)?.gate.id).toBe(first.id);
  expect(connectorToolOf(`mcp__plugin_metro_${two}__read`)?.gate.id).toBe(second.id);
  expect(connectorToolOf('mcp__metro_box_Identical__read')).toBeUndefined();
  expect(blockedReason(first.id, 'read')).toContain('Blocked');
  expect(blockedReason(second.id, 'read')).toBeNull();
  expect(blockedReason(second.id, 'write')).toContain('Blocked');
  const servers = pluginServers(rows, 'http://127.0.0.1:12345', keys);
  expect(Object.keys(servers)).toHaveLength(2);
  expect(JSON.stringify(servers)).not.toContain('private-fixture');
  expect(JSON.stringify(servers)).not.toContain('Bearer');
  await localDeleteConnector(first.id, dir);
  await localRenameConnector(second.id, 'Renamed', dir);
  expect(persistentServerKeys(readLocalConnectors(dir), dir).get(second.id)).toBe(two);
  expect((await localRelayTarget(second.id, false, dir)).kind).toBe('ok');
});

test('same-endpoint OAuth instances reconnect and sign out separately', async () => {
  const first = await localCreateConnector(input('first-fixture'), dir);
  const second = await localCreateConnector(input('second-fixture'), dir);
  const oauth = (token: string) => ({ kind: 'oauth' as const, issuer: base, tokenEndpoint: `${base}/token`, clientId: token, accessToken: token, refreshToken: `refresh-${token}` });
  await localReconnectConnector(first.id, oauth('one-fixture'), dir);
  await localReconnectConnector(second.id, oauth('two-fixture'), dir);
  await localDisconnectConnector(first.id, dir);
  expect(await localRelayTarget(second.id, false, dir)).toMatchObject({ headers: { Authorization: 'Bearer two-fixture' } });
  expect(readLocalConnectors(dir)[0]?.config.auth).toEqual({ kind: 'none' });
  expect(readLocalConnectors(dir)[1]?.config.auth).toEqual(oauth('two-fixture'));
});

test('imports match IDs only and explicit copies preserve each same-name source without merging', () => {
  const config = (value: string) => readConfig({ auth: { kind: 'header', name: 'Authorization', value }, policy: { write: value === 'one-fixture' ? 'deny' : 'ask' } });
  const first = { id: 'conn0000001', name: 'Same', url: 'https://example.com/mcp', config: config('one-fixture') };
  const second = { ...first, id: 'conn0000002', config: config('two-fixture') };
  localImportConnectors([first], dir);
  localImportConnectors([second], dir, 'append');
  expect(readLocalConnectors(dir)).toEqual([first, second]);
  localImportConnectors([{ ...second, name: 'Same', config: { ...second.config, policy: { write: 'allow' } } }], dir);
  expect(readLocalConnectors(dir)[0]).toEqual(first);
  expect(readLocalConnectors(dir)[1]?.config.policy).toEqual({ write: 'allow' });
  const copied = copyConnectorRows({ version: 1, connectors: [first, second] }, dir);
  expect(copied.map((row) => row.status)).toEqual(['copied', 'copied']);
  const rows = readLocalConnectors(dir);
  expect(new Set(rows.map((row) => row.id)).size).toBe(4);
  expect(rows[2]?.config).toEqual(first.config);
  expect(rows[3]?.config).toEqual(second.config);
  const before = readFileSync(join(dir, 'connectors.json'), 'utf8');
  expect(() => localImportConnectors([first, first], dir)).toThrow('duplicate connector IDs');
  expect(readFileSync(join(dir, 'connectors.json'), 'utf8')).toBe(before);
});

test('losing either initialized namespace file cannot reassign a retired instance key after restart', () => {
  const rows = [{ id: 'conn0000001', name: 'Calendar' }, { id: 'conn0000002', name: 'Calendar' }];
  const original = persistentServerKeys(rows, dir);
  const survivors = rows.slice(1);
  expect(persistentServerKeys(survivors, dir)).toEqual(original);
  for (const file of ['connector-server-keys.json', 'connector-server-keys.initialized']) {
    const path = join(dir, file);
    const saved = readFileSync(path, 'utf8');
    rmSync(path);
    try { expect(() => persistentServerKeys(survivors, dir)).toThrow('Restore'); }
    finally { writeFileSync(path, saved); }
  }
  expect(persistentServerKeys(survivors, dir)).toEqual(original);
});

test('initial namespace migration preserves the last published owner of every colliding legacy key', () => {
  const rows = [{ id: 'conn0000001', name: 'Linear' }, { id: 'conn0000002', name: 'linear!' }, { id: 'conn0000003', name: 'linear-conn' }, { id: 'conn0000004', name: 'linear?' }];
  const keys = persistentServerKeys(rows, dir);
  expect(keys.get('conn0000001')).toBe('linear');
  expect(keys.get('conn0000004')).toBe('linear-conn');
  expect(keys.get('conn0000002')).not.toBe('linear-conn');
  expect(keys.get('conn0000003')).not.toBe('linear-conn');
  expect(new Set(keys.values()).size).toBe(4);
  expect(pluginServers(rows, 'http://127.0.0.1', keys)['linear-conn']?.url).toEndWith('/relay/conn0000004');
  expect(persistentServerKeys([...rows].reverse(), dir)).toEqual(keys);
});

test('every visibility subset preserves baseline collision ordinals and final published owners', () => {
  const orgKey = 'org-linear-636f6e6e30303030303031';
  const rows = ['Linear', 'linear!', 'linear-conn', 'linear?', orgKey].map((name, index) => ({ id: `conn000000${String(index + 1)}`, name }));
  rows.push({ id: 'org-conn0000001', name: 'Linear' });
  const legacy = ['linear', 'linear-conn', 'linear-conn', 'linear-conn', orgKey, `${orgKey}-1`];
  for (let mask = 0; mask < 2 ** rows.length; mask += 1) {
    const published = rows.filter((_row, index) => Math.floor(mask / 2 ** index) % 2 !== 0);
    const owners = Object.fromEntries(rows.flatMap((row, index) => published.includes(row) ? [[legacy[index], row.id]] : []));
    const keys = serverKeysOf(rows, undefined, published);
    const servers = pluginServers(published, 'http://127.0.0.1', keys);
    for (const [key, id] of Object.entries(owners)) expect(servers[key]?.url).toEndWith(`/relay/${id}`);
    expect(new Set(keys.values()).size).toBe(rows.length);
    expect(serverKeysOf(rows, keys)).toEqual(keys);
  }
});

test('legacy tool keys remain owned across deletion, rename, reorder and colliding additions', () => {
  const rows = [{ id: 'conn0000001', name: 'Linear' }, { id: 'conn0000002', name: 'linear!' }, { id: 'org-conn0000001', name: 'Linear' }];
  const legacy = persistentServerKeys(rows, dir);
  expect(legacy.get(rows[0]?.id ?? '')).toBe('linear');
  expect(legacy.get(rows[1]?.id ?? '')).toBe('linear-conn');
  expect(legacy.get('org-conn0000001')).toBe('org-linear-636f6e6e30303030303031');
  const changed = [{ id: 'conn0000002', name: 'Other' }, { id: 'conn0000003', name: 'linear' }, { id: 'conn0000004', name: 'linear-conn' }, { id: 'conn0000005', name: 'linear!' }, { id: 'org-conn0000001', name: 'Other' }];
  const next = persistentServerKeys(changed, dir);
  for (const [id, key] of legacy) expect(next.get(id)).toBe(key);
  expect(new Set(next.values()).size).toBe(next.size);
  expect(persistentServerKeys([...changed].reverse(), dir)).toEqual(next);
  const fresh = serverKeysOf([...rows, ...changed]);
  expect(new Set(fresh.values()).size).toBe(fresh.size);
  writeFileSync(join(dir, 'connector-server-keys.json'), '{bad');
  expect(() => persistentServerKeys(changed, dir)).toThrow();
});
