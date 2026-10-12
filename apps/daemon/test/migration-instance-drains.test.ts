import { afterEach, beforeEach, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beginLocalMigrationOperation, localMigrationIdle } from '../src/connectors/migration-guard.js';
import { migrationUncertaintyReceipt } from '../src/connectors/migration-operations.js';
import { migrationRecord, saveMigration } from '../src/connectors/migration-state.js';
import { localImportConnectors, localRenameConnector, readLocalConnectors } from '../src/connectors/store.js';
import { persistentServerKeys } from '../src/connectors/server-keys.js';
import { blockedReason, connectorToolOf, registerConnectors } from '../src/connectors/gates.js';
import { isolatePassiveTests, passiveFixture, SOURCE, type PassiveFixture } from './migration-passive-fixture.js';
import { within } from './org-sync-control-fixture.js';

const OTHER = 'conn0000002';
let restore: () => void;
let cleanup: (() => Promise<void>) | undefined;
let f: PassiveFixture;
beforeEach(async () => { restore = isolatePassiveTests(); cleanup = undefined; f = await passiveFixture(); cleanup = f.close; });
afterEach(async () => { try { await cleanup?.(); } finally { registerConnectors([]); restore(); } });

function duplicate() {
  const first = readLocalConnectors(f.dir)[0];
  if (first === undefined) throw new Error('missing first instance');
  const other = { ...first, id: OTHER, config: { ...first.config, auth: { kind: 'header' as const, name: 'Authorization', value: 'other-fixture-key' }, policy: { read: 'allow' as const, write: 'allow' as const } } };
  localImportConnectors([other], f.dir);
  return other;
}

function freezeOther(): void {
  const record = migrationRecord(SOURCE, f.dir);
  if (record === null) throw new Error('missing first migration');
  saveMigration({ ...record, id: 'oper0000002', sourceId: OTHER, destinationId: null, phase: 'freezing' }, f.dir);
}

const journal = (id: string) => readFileSync(join(f.dir, `connector-migration-operations-${id}.json`), 'utf8');

test('same-name instances drain concurrently by ID without sharing active work, namespaces or permissions', async () => {
  const other = duplicate();
  const rows = readLocalConnectors(f.dir);
  expect(rows[0]?.name).toBe(other.name);
  expect(rows[0]?.url).toBe(other.url);
  const keys = persistentServerKeys(rows, f.dir);
  registerConnectors(rows, keys);
  const first = await f.start();
  const second = await f.start({}, OTHER);
  const third = await f.start({}, OTHER);
  const operation = beginLocalMigrationOperation(SOURCE, f.dir);
  try {
    await f.freeze(); freezeOther();
    expect(localMigrationIdle(SOURCE, f.dir)).toBe(false);
    expect(localMigrationIdle(OTHER, f.dir)).toBe(false);
    expect(await within(second.text)).toBe(': listener\n\n');
    expect(await within(third.text)).toBe(': listener\n\n');
    expect(localMigrationIdle(OTHER, f.dir)).toBe(true);
    expect(first.remote.destroyed).toBe(false);
    operation.close();
    expect(localMigrationIdle(SOURCE, f.dir)).toBe(false);
    expect(await within(first.text)).toBe(': listener\n\n');
    expect(localMigrationIdle(SOURCE, f.dir)).toBe(true);
    expect(persistentServerKeys([...rows].reverse(), f.dir)).toEqual(keys);
    for (const row of rows) expect(connectorToolOf(`mcp__plugin_metro_${keys.get(row.id) ?? ''}__write`)?.gate.id).toBe(row.id);
    expect(blockedReason(SOURCE, 'write')).toContain('Blocked');
    expect(blockedReason(OTHER, 'write')).toBeNull();
    expect(keys.get(SOURCE)).not.toBe(keys.get(OTHER));
    expect(readLocalConnectors(f.dir)).toEqual(rows);
    for (const id of [SOURCE, OTHER]) expect(JSON.parse(journal(id))).toEqual({ version: 1, pending: [] });
  } finally { operation.close(); }
});

for (const refresh of [false, true]) {
  test(`same-name passive drains preserve an unknown ${refresh ? 'refresh' : 'request'} receipt only on its own instance`, async () => {
    if (refresh) { await f.close(); cleanup = undefined; f = await passiveFixture(true); cleanup = f.close; }
    const other = duplicate();
    const first = await f.start();
    const second = await f.start({}, OTHER);
    const operation = beginLocalMigrationOperation(SOURCE, f.dir);
    try {
      await expect(operation.dispatch(() => Promise.reject(new Error('lost fixture reply')), { refresh })).rejects.toThrow('lost fixture reply');
      await f.freeze(); freezeOther(); operation.close();
      const receipt = migrationUncertaintyReceipt(SOURCE, f.dir);
      const pending = journal(SOURCE);
      expect(receipt).not.toBeNull();
      expect(localMigrationIdle(SOURCE, f.dir)).toBe(false);
      expect(localMigrationIdle(OTHER, f.dir)).toBe(false);
      await within(Promise.all([first.text, second.text]));
      expect(localMigrationIdle(OTHER, f.dir)).toBe(true);
      expect(migrationUncertaintyReceipt(OTHER, f.dir)).toBeNull();
      expect(localMigrationIdle(SOURCE, f.dir)).toBe(false);
      expect(journal(SOURCE)).toBe(pending);
      const record = migrationRecord(SOURCE, f.dir);
      if (record === null) throw new Error('missing migration');
      await f.control.run(SOURCE, 'resolve', f.status.scope, record.id, receipt);
      expect(migrationUncertaintyReceipt(SOURCE, f.dir)).toBeNull();
      expect(migrationRecord(SOURCE, f.dir)?.phase).toBe(refresh ? 'rolled_back' : 'freezing');
      expect(migrationRecord(OTHER, f.dir)).toMatchObject({ id: 'oper0000002', phase: 'freezing' });
      expect(readLocalConnectors(f.dir).find((row) => row.id === OTHER)).toEqual(other);
      expect(JSON.parse(journal(OTHER))).toEqual({ version: 1, pending: [] });
    } finally { operation.close(); }
  });
}

test('lost migration replies retry the same instance without draining or editing its identical sibling', async () => {
  const other = duplicate();
  const keys = persistentServerKeys(readLocalConnectors(f.dir), f.dir);
  const first = await f.start();
  const second = await f.start({}, OTHER);
  f.controls.drop = 'prepare';
  await expect(f.move()).rejects.toThrow('not confirmed');
  await within(first.text);
  const record = migrationRecord(SOURCE, f.dir);
  if (record === null) throw new Error('missing migration');
  expect(second.remote.destroyed).toBe(false);
  expect(localMigrationIdle(OTHER, f.dir)).toBe(false);
  await expect(localRenameConnector(OTHER, other.name, f.dir)).resolves.toMatchObject({ id: OTHER });
  expect((await within(f.move())).migrations.find((row) => row.sourceId === SOURCE)).toMatchObject({ id: record.id, phase: 'active' });
  expect(f.controls.creates).toBe(1);
  expect(f.controls.assignments).toBe(1);
  expect(migrationRecord(OTHER, f.dir)).toBeNull();
  expect(persistentServerKeys(readLocalConnectors(f.dir), f.dir)).toEqual(keys);
  expect(readLocalConnectors(f.dir).find((row) => row.id === OTHER)).toEqual(other);
  second.remote.end();
  expect(await within(second.text)).toBe(': listener\n\n');
});
