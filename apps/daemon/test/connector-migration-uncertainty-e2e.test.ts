import { afterEach, describe, expect, test } from 'bun:test';
import { connectorAgents, connectorMigrations, connectors } from '../../api/src/db/schema.js';
import { destinationId, MIGRATIONS, migrationE2E, SOURCE, TEST_DATABASE_URL, type MigrationE2E } from './migration-e2e-fixture.js';
import { POLICY } from './migration-e2e-vendor.js';
import { within } from './org-sync-control-fixture.js';

let fixture: MigrationE2E | undefined;
afterEach(async () => { await fixture?.close(); fixture = undefined; });

async function prepared(f: MigrationE2E, side: 'local' | 'alias', before?: () => Promise<void>) {
  const policy = { ...POLICY, tools: { ...POLICY.tools, hold_write: 'allow' } };
  expect((await f.request(`/api/connectors/${SOURCE}/policy`, 'PUT', { policy })).status).toBe(200);
  await f.setSync(true); await before?.(); const record = await f.move('prepare');
  if (side === 'alias') expect((await f.move('cutover')).phase).toBe('active');
  return record;
}

describe.skipIf(TEST_DATABASE_URL === undefined)('uncertain vendor writes keep migration fenced through real daemon HTTP', () => {
  for (const side of ['local', 'alias'] as const) {
    for (const interrupt of ['caller abort', 'daemon restart'] as const) {
      test(`${side} ${interrupt} cannot mistake a disconnected vendor write for completion`, async () => {
        const f = fixture = await migrationE2E();
        const controller = new AbortController();
        let response: Response | undefined;
        const before = side === 'local' && interrupt === 'caller abort' ? async () => { response = await f.tool('hold_write', SOURCE, controller.signal); } : undefined;
        const record = await prepared(f, side, before);
        const action = side === 'local' ? 'cutover' : 'rollback';
        const phase = side === 'local' ? 'cutover' : 'rollback';
        const assignments = side === 'local' ? 0 : 1;
        response ??= await f.tool('hold_write', SOURCE, controller.signal);
        expect(response.status).toBe(200);
        const body = response.text().then(() => 'completed', () => 'disconnected');
        await within(f.vendor.writeHeld());
        expect(f.vendor.effects).toEqual({ started: 1, completed: 0 });
        expect(await f.move(action)).toMatchObject({ id: record.id, phase, reason: 'waiting_for_local' });
        expect((await f.action('resolve')).status).toBe(400);
        expect(await f.held.db1.$count(connectorAgents)).toBe(assignments);
        if (interrupt === 'caller abort') controller.abort();
        else await f.restart(true);
        expect(await within(body)).toBe('disconnected');
        await within(f.vendor.writeDisconnected());
        const uncertain = await f.move(action);
        expect(uncertain).toMatchObject({ id: record.id, phase, reason: 'requests_uncertain' });
        expect(uncertain.uncertainty).toMatch(/^[a-f0-9]{64}$/);
        expect(f.vendor.effects).toEqual({ started: 1, completed: 0 });
        expect((await f.tool()).status).toBe(409);
        expect(await f.held.db1.$count(connectorAgents)).toBe(assignments);
        await f.restart();
        expect(await f.move('reconcile')).toMatchObject({ id: record.id, phase, reason: 'requests_uncertain', uncertainty: uncertain.uncertainty });
        expect(await f.held.db1.$count(connectorAgents)).toBe(assignments);
        expect(f.vendor.calls.filter((call) => call.tool === 'hold_write')).toHaveLength(1);
        f.vendor.completeWrites();
        expect(f.vendor.effects).toEqual({ started: 1, completed: 1 });
        expect(await f.move('reconcile')).toMatchObject({ phase, reason: 'requests_uncertain' });
        const current = await f.status();
        const resolve = { sourceId: SOURCE, action: 'resolve', scope: current.scope, operationId: record.id, uncertainty: uncertain.uncertainty };
        expect((await f.request(MIGRATIONS, 'POST', resolve, f.member)).status).toBe(403);
        expect((await f.request(MIGRATIONS, 'POST', resolve, f.stranger)).status).toBe(403);
        expect((await f.request(MIGRATIONS, 'POST', { ...resolve, uncertainty: '0'.repeat(64) })).status).toBe(409);
        expect(await f.move('resolve')).toMatchObject({ id: record.id, phase, uncertainty: null });
        expect(await f.held.db1.$count(connectorAgents)).toBe(assignments);
        expect((await f.tool()).status).toBe(409);
        expect(f.vendor.effects).toEqual({ started: 1, completed: 1 });
        expect((await f.move('reconcile')).phase).toBe(side === 'local' ? 'active' : 'rolled_back');
        expect(await f.held.db1.$count(connectorAgents)).toBe(side === 'local' ? 1 : 0);
        expect((await f.tool()).status).toBe(200);
        expect(f.vendor.calls.filter((call) => call.tool === 'hold_write')).toHaveLength(1);
        expect(await f.held.db1.$count(connectors)).toBe(1);
        expect(await f.held.db1.$count(connectorMigrations)).toBe(1);
      });
    }
  }

  test('a valid receipt cannot settle another live write, and a later unknown write invalidates the old receipt', async () => {
    const f = fixture = await migrationE2E(); const record = await prepared(f, 'local');
    const first = new AbortController(); const second = new AbortController();
    const firstResponse = await f.tool('hold_write', SOURCE, first.signal);
    const firstBody = firstResponse.text().then(() => 'completed', () => 'disconnected');
    const secondResponse = await f.tool('hold_write', SOURCE, second.signal);
    let secondSettled = false;
    const secondBody = secondResponse.text().then(() => 'completed', () => 'disconnected').finally(() => { secondSettled = true; });
    expect(f.vendor.effects).toEqual({ started: 2, completed: 0 });
    expect((await f.move('cutover')).reason).toBe('waiting_for_local');
    first.abort(); expect(await within(firstBody)).toBe('disconnected'); await within(f.vendor.writeDisconnected());
    const uncertain = await f.move('cutover');
    expect(uncertain.reason).toBe('requests_uncertain'); expect(uncertain.uncertainty).toMatch(/^[a-f0-9]{64}$/);
    expect(f.vendor.disconnectedWrites()).toBe(1); expect(secondSettled).toBe(false); expect(second.signal.aborted).toBe(false);
    expect((await f.action('resolve')).status).toBe(409);
    expect((await f.status()).migrations[0]?.uncertainty).toBe(uncertain.uncertainty);
    expect(secondSettled).toBe(false);
    expect(await f.held.db1.$count(connectorAgents)).toBe(0);
    second.abort(); expect(await within(secondBody)).toBe('disconnected');
    await within((async () => { while (f.vendor.disconnectedWrites() < 2) await Bun.sleep(5); })());
    const current = await f.status();
    const latest = current.migrations[0]; if (latest === undefined) throw new Error('missing migration');
    expect(latest.uncertainty).not.toBe(uncertain.uncertainty);
    expect((await f.request(MIGRATIONS, 'POST', { sourceId: SOURCE, action: 'resolve', scope: current.scope, operationId: record.id, uncertainty: uncertain.uncertainty })).status).toBe(409);
    expect((await f.tool()).status).toBe(409);
    f.vendor.completeWrites(); expect(f.vendor.effects).toEqual({ started: 2, completed: 2 });
    expect((await f.move('resolve')).uncertainty).toBeNull();
    expect(await f.held.db1.$count(connectorAgents)).toBe(0);
    expect((await f.move('reconcile')).phase).toBe('active');
    expect(f.vendor.calls.filter((call) => call.tool === 'hold_write')).toHaveLength(2);
    expect(f.vendor.effects).toEqual({ started: 2, completed: 2 });
  });

  test('stale browser operation IDs cannot mutate a newer generation in the same enrollment scope', async () => {
    const f = fixture = await migrationE2E();
    await f.setSync(true); const first = await f.move('prepare');
    const scope = (await f.status()).scope;
    expect((await f.move('rollback')).phase).toBe('rolled_back');
    expect((await f.manage(`/${destinationId(first)}`, 'PUT', { name: 'Retained prior destination' })).status).toBe(200);
    const next = await f.move('prepare');
    expect(next.id).not.toBe(first.id);
    expect(destinationId(next)).not.toBe(destinationId(first));
    expect((await f.status()).scope).toBe(scope);
    const sent = f.traffic.length;
    for (const action of ['prepare', 'reconcile', 'cutover', 'rollback', 'resolve']) {
      const body = { sourceId: SOURCE, action, scope, operationId: first.id, ...(action === 'resolve' ? { uncertainty: '0'.repeat(64) } : {}) };
      expect((await f.request(MIGRATIONS, 'POST', body)).status).toBe(409);
    }
    expect(f.traffic.length).toBe(sent);
    expect((await f.status()).migrations[0]).toMatchObject({ id: next.id, phase: 'prepared' });
    expect(await f.held.db1.$count(connectorAgents)).toBe(0);
    expect(await f.held.db1.$count(connectors)).toBe(2);
    expect((await f.move('cutover')).phase).toBe('active');
    expect(await f.held.db1.$count(connectorAgents)).toBe(1);
  });
});
