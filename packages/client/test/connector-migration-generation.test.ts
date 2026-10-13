import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { MIGRATION_UNCERTAIN } from '../src/api/connector-migration-flow.js';
import { SOURCE, SCOPE, migrationFixture, migrationRow, statusBody } from './connector-migration-fixture.js';

let fixture: ReturnType<typeof migrationFixture>;
beforeEach(() => { fixture = migrationFixture(); });
afterEach(() => { fixture.close(); });
const bodies = () => fixture.requests.filter((row) => row.init.method === 'POST').map((row) => JSON.parse(String(row.init.body)));

describe('migration operation and request-fence binding', () => {
  test('every action binds its confirmed operation, including preparation after rollback', async () => {
    fixture.status = statusBody([migrationRow('rolled_back')]);
    const session = fixture.open();
    await session.refresh();
    fixture.reply = statusBody([{ ...migrationRow(), id: 'migration02' }]);
    await session.act(SOURCE, 'prepare');
    await session.act(SOURCE, 'reconcile');
    expect(bodies()).toEqual([
      { scope: SCOPE, sourceId: SOURCE, action: 'prepare', operationId: 'migration01' },
      { scope: SCOPE, sourceId: SOURCE, action: 'reconcile', operationId: 'migration02' },
    ]);
  });

  test('a stale operation refusal is never silently retried against a replacement migration', async () => {
    fixture.status = statusBody([migrationRow()]);
    const session = fixture.open();
    await session.refresh();
    fixture.postCode = 409;
    fixture.reply = { error: 'The operation changed. Refresh.' };
    await expect(session.act(SOURCE, 'cutover')).rejects.toThrow(MIGRATION_UNCERTAIN);
    expect(bodies()).toEqual([{ scope: SCOPE, sourceId: SOURCE, action: 'cutover', operationId: 'migration01' }]);
    fixture.status = statusBody([{ ...migrationRow(), id: 'migration02' }]);
    await session.refresh();
    expect(bodies()).toHaveLength(1);
    fixture.postCode = 200;
    fixture.reply = fixture.status;
    await session.act(SOURCE, 'reconcile');
    expect(bodies()[1]?.operationId).toBe('migration02');
  });

  test('resolve is explicit and carries only the confirmed request receipt and operation', async () => {
    fixture.status = statusBody([migrationRow('cutover', 'requests_uncertain')]);
    const session = fixture.open();
    await session.refresh();
    expect(bodies()).toHaveLength(0);
    fixture.reply = statusBody([migrationRow('cutover')]);
    const resolved = await session.act(SOURCE, 'resolve');
    expect(bodies()).toEqual([{ scope: SCOPE, sourceId: SOURCE, action: 'resolve', operationId: 'migration01', uncertainty: 'b'.repeat(64) }]);
    expect(resolved.status?.migrations[0]?.phase).toBe('cutover');
    expect(resolved.status?.migrations[0]?.uncertainty).toBeNull();
    expect(fixture.requests).toHaveLength(4);
    await expect(session.act(SOURCE, 'resolve')).rejects.toThrow('find the open request');
    expect(bodies()).toHaveLength(1);
  });

  test('a stale receipt needs Refresh and a new explicit confirmation, never a retry', async () => {
    fixture.status = statusBody([migrationRow('rollback', 'requests_uncertain')]);
    const session = fixture.open();
    await session.refresh();
    fixture.postCode = 409;
    fixture.reply = { error: 'The outstanding requests changed.' };
    await expect(session.act(SOURCE, 'resolve')).rejects.toThrow(MIGRATION_UNCERTAIN);
    expect(bodies()[0]?.uncertainty).toBe('b'.repeat(64));
    fixture.status = statusBody([{ ...migrationRow('rollback', 'requests_uncertain'), uncertainty: 'c'.repeat(64) }]);
    await session.refresh();
    expect(bodies()).toHaveLength(1);
    fixture.postCode = 200;
    fixture.reply = statusBody([migrationRow('rollback')]);
    await session.act(SOURCE, 'resolve');
    expect(bodies()[1]?.uncertainty).toBe('c'.repeat(64));
    expect(session.snapshot().status?.migrations[0]?.phase).toBe('rollback');
  });

  test('an open confirmation cannot silently adopt a refreshed operation or request receipt', async () => {
    fixture.status = statusBody([migrationRow('prepared', 'requests_uncertain')]);
    const session = fixture.open();
    await session.refresh();
    const displayed = { operationId: 'migration01', uncertainty: 'b'.repeat(64) };
    fixture.status = statusBody([{ ...migrationRow('prepared', 'requests_uncertain'), id: 'migration02', uncertainty: 'c'.repeat(64) }]);
    await session.refresh();
    await expect(session.act(SOURCE, 'rollback', displayed)).rejects.toThrow('changed since this was shown');
    await expect(session.signIn(SOURCE, displayed)).rejects.toThrow('changed since this was shown');
    await expect(session.act(SOURCE, 'resolve', { ...displayed, operationId: 'migration02' })).rejects.toThrow('changed since this was shown');
    expect(bodies()).toHaveLength(0);
    fixture.reply = statusBody([{ ...migrationRow(), id: 'migration02' }]);
    await session.act(SOURCE, 'resolve', { operationId: 'migration02', uncertainty: 'c'.repeat(64) });
    expect(bodies()).toEqual([{ scope: SCOPE, sourceId: SOURCE, action: 'resolve', operationId: 'migration02', uncertainty: 'c'.repeat(64) }]);
  });

  test('missing or malformed receipts cannot be acknowledged', async () => {
    for (const uncertainty of [undefined, 'private-data', 'f'.repeat(63), 1]) {
      fixture.status = statusBody([{ ...migrationRow('cutover', 'requests_uncertain'), uncertainty }]);
      const session = fixture.open();
      expect((await session.refresh()).statusError).not.toBeNull();
      await expect(session.act(SOURCE, 'resolve')).rejects.toThrow('Refresh');
    }
    fixture.status = statusBody([{ ...migrationRow('cutover', 'requests_uncertain'), uncertainty: null }]);
    const session = fixture.open();
    await session.refresh();
    await expect(session.act(SOURCE, 'resolve')).rejects.toThrow('find the open request');
    expect(bodies()).toHaveLength(0);
  });
});
