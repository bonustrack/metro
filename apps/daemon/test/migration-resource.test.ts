import { afterEach, expect, test } from 'bun:test';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { migrationPayload } from '../src/connectors/migration-source.ts';
import { migrationSource } from '../src/connectors/migration-preview.ts';
import { migrationRecord, saveMigration } from '../src/connectors/migration-state.ts';
import { migrationFixture, SOURCE } from './migration-control-fixture.ts';

const RESOURCE = 'https://mcp.example.com/mcp';
const CHANGED_RESOURCE = 'https://mcp.example.com';
const REQUIRED = "Enter the provider's public OAuth resource. Roll back this preparation, then prepare again with that public value; never enter credentials.";
const dirs: string[] = [];
const fixture = (oauth = true) => { const f = migrationFixture(oauth); dirs.push(f.dir); return f; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function record(f: ReturnType<typeof fixture>) {
  const value = migrationRecord(SOURCE, f.dir);
  if (value === null) throw new Error('Missing fixture migration');
  return value;
}

test('explicit resource is sealed, stamped and retained across reconstructed preparation and source checks', async () => {
  const f = fixture();
  const local = { ...f.source, url: 'https://mcp.example.com/mcp/private/workspace?key=local-secret' };
  writeFileSync(join(f.dir, 'connectors.json'), JSON.stringify({ version: 1, connectors: [local] }));
  const unchanged = f.readSource();
  const source = migrationSource(SOURCE, f.dir);
  expect(migrationPayload(source)).not.toHaveProperty('oauthResource');
  const expected = migrationPayload(source, RESOURCE);
  expect(expected.sourceStamp).not.toBe(migrationPayload(source).sourceStamp);
  expect(expected.sourceStamp).not.toBe(migrationPayload(source, CHANGED_RESOURCE).sourceStamp);
  f.controls.drop = 'prepare';
  await expect(f.control().run(SOURCE, 'prepare', f.status.scope, null, null, RESOURCE)).rejects.toThrow('not confirmed');
  expect(record(f)).toMatchObject({ oauthResource: RESOURCE, sourceStamp: expected.sourceStamp, phase: 'preparing' });
  const serialized = readFileSync(join(f.dir, 'connector-migrations.json'), 'utf8');
  expect(serialized).toContain(RESOURCE);
  expect(serialized).not.toContain(local.url);
  expect(f.payload()).toEqual(expected);
  const resumed = await f.control().run(SOURCE, 'reconcile', f.status.scope, record(f).id);
  expect(resumed.migrations[0]?.phase).toBe('prepared');
  expect(JSON.stringify(resumed)).not.toContain(RESOURCE);
  expect(f.controls.creates).toBe(1);
  expect(f.readSource()).toBe(unchanged);
  f.ready();
  await f.control().run(SOURCE, 'cutover', f.status.scope, record(f).id);
  expect(record(f).phase).toBe('active');
});

test('an existing preparation cannot change its chosen resource, but rollback permits a new choice', async () => {
  const f = fixture();
  await f.control().run(SOURCE, 'prepare', f.status.scope, null, null, RESOURCE);
  const original = record(f);
  const calls = f.requests.length;
  for (const action of ['prepare', 'reconcile', 'cutover', 'rollback'] as const) {
    await expect(f.control().run(SOURCE, action, f.status.scope, original.id, null, CHANGED_RESOURCE)).rejects.toThrow('Roll back');
  }
  expect(f.requests).toHaveLength(calls);
  expect(record(f)).toEqual(original);
  await f.control().run(SOURCE, 'prepare', f.status.scope, original.id, null, RESOURCE);
  expect(record(f).oauthResource).toBe(RESOURCE);
  await f.control().run(SOURCE, 'rollback', f.status.scope, original.id);
  expect(record(f).phase).toBe('rolled_back');
  await f.control().run(SOURCE, 'prepare', f.status.scope, original.id, null, CHANGED_RESOURCE);
  expect(record(f)).toMatchObject({ phase: 'prepared', oauthResource: CHANGED_RESOURCE });
  expect(record(f).id).not.toBe(original.id);
  expect(record(f).sourceStamp).not.toBe(original.sourceStamp);
});

test('an omitted choice is immutable and resource validation never normalizes an unsafe identifier', async () => {
  const f = fixture();
  await f.control().run(SOURCE, 'prepare', f.status.scope, null);
  const original = record(f);
  await expect(f.control().run(SOURCE, 'prepare', f.status.scope, original.id, null, RESOURCE)).rejects.toThrow('Roll back');
  expect(record(f)).not.toHaveProperty('oauthResource');
  for (const resource of ['', 'https://mcp.example.com/?secret=1', 'http://public.example.com/resource', 'https://127.0.0.1/resource']) {
    expect(() => saveMigration({ ...original, oauthResource: resource }, f.dir)).toThrow();
  }
  expect(record(f)).toEqual(original);
  const header = fixture(false);
  await expect(header.control().run(SOURCE, 'prepare', header.status.scope, null, null, RESOURCE)).rejects.toThrow('Only an OAuth');
  expect(migrationRecord(SOURCE, header.dir)).toBeNull();
  expect(header.requests).toEqual([]);
});

test('historical token metadata is discarded, never used to infer a resource or downgrade OAuth', async () => {
  const f = fixture();
  const source = { ...f.source, config: { ...f.source.config, oauth: false, auth: { kind: 'oauth', issuer: '', expiresAt: 'invalid', accessToken: 'old-secret' } } };
  writeFileSync(join(f.dir, 'connectors.json'), JSON.stringify({ version: 1, connectors: [source] }));
  await f.control().run(SOURCE, 'prepare', f.status.scope, null);
  expect(f.payload()).toMatchObject({ auth: { kind: 'oauth' }, client: source.config.client, policy: source.config.policy });
  expect(f.payload()).not.toHaveProperty('oauthResource');
  expect(JSON.stringify(f.payload())).not.toContain('old-secret');
  expect(f.readSource()).toContain('old-secret');
  await f.control().run(SOURCE, 'rollback', f.status.scope, record(f).id);
  expect(f.readSource()).not.toContain('old-secret');
  expect(JSON.parse(f.readSource()).connectors[0].config).toMatchObject({ oauth: true, auth: { kind: 'none' }, client: source.config.client, policy: source.config.policy });
});

test('only the known preparation refusal yields the fixed public-resource recovery prompt', async () => {
  for (const [action, status, code, expected] of [
    ['prepare', 400, 'oauth_resource_required', REQUIRED],
    ['prepare', 500, 'oauth_resource_required', 'not confirmed'],
    ['prepare', 400, 'other', 'not confirmed'],
    ['begin', 400, 'oauth_resource_required', 'not confirmed'],
  ] as const) {
    const f = fixture();
    f.controls.refusal = { action, status, code };
    const error = await f.control().run(SOURCE, 'prepare', f.status.scope, null).then(() => null, (err: unknown) => err);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain(expected);
    expect(String(error)).not.toContain('arbitrary-upstream-private-secret');
    expect(record(f)).toMatchObject({ phase: 'preparing', reason: 'unavailable' });
  }
});
