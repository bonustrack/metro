import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { connectorAgents, connectors } from '../../api/src/db/schema.js';
import { latch } from '../../api/test/connector-delivery-fixture.js';
import { ACCESS, REFRESH } from '../../api/test/org-connectors-fixture.js';
import { localMigrationEnabled } from '../src/connectors/migration-guard.js';
import { migrationRecord, saveMigration } from '../src/connectors/migration-state.js';
import { migrationRefreshUncertain, migrationUncertaintyReceipt, resolveMigrationUncertainty } from '../src/connectors/migration-operations.js';
import { readLocalConnectors } from '../src/connectors/store.js';
import { destinationId, migrationE2E, SOURCE, TEST_DATABASE_URL, type MigrationE2E } from './migration-e2e-fixture.js';
import { LOCAL_ACCESS, VENDOR } from './migration-e2e-vendor.js';

let fixture: MigrationE2E | undefined;
afterEach(async () => { await fixture?.close(); fixture = undefined; });

async function until(check: () => boolean): Promise<void> {
  for (let n = 0; n < 200; n += 1) { if (check()) return; await Bun.sleep(10); }
  throw new Error('fixture condition did not settle');
}

async function source() {
  const f = fixture = await migrationE2E('oauth-dynamic', (row) => {
    if (row.config.auth.kind !== 'oauth') throw new Error('OAuth expected');
    row.config.auth = { ...row.config.auth, refreshToken: REFRESH, expiresAt: 1 };
  });
  await f.setSync(true);
  return f;
}

describe.skipIf(TEST_DATABASE_URL === undefined)('local refresh ownership handover', () => {
  test('waits for an in-flight refresh to persist final credentials before sealing them', async () => {
    const f = await source();
    const hold = latch();
    const original = globalThis.fetch;
    globalThis.fetch = Object.assign(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url) === `${VENDOR}/token`) await hold.pause();
      return original(url, init);
    }, { preconnect: original.preconnect });
    try {
      const local = f.tool();
      await hold.reached;
      const move = f.move('move');
      await until(() => !localMigrationEnabled(SOURCE, f.dir));
      expect(readFileSync(join(f.dir, `connector-migration-operations-${SOURCE}.json`), 'utf8')).toMatch(/"r[a-f0-9]{32}"/);
      expect(await f.held.db1.$count(connectors)).toBe(0);
      hold.release();
      expect((await local).status).toBe(409);
      const result = await move;
      expect(result.phase).toBe('active');
      const secret = (await f.destination(destinationId(result))).secret;
      expect(secret).toMatchObject({ tokens: { accessToken: ACCESS, refreshToken: REFRESH } });
      expect(readLocalConnectors(f.dir)[0]?.config.auth).toMatchObject({ accessToken: ACCESS });
      expect(f.vendor.oauth.tokenCalls).toBe(1);
      expect(migrationRefreshUncertain(SOURCE, f.dir)).toBe(false);
    } finally { hold.release(); globalThis.fetch = original; }
  });

  test('lost local refresh reply remains uncertain across restart and explicit recovery discards stale tokens', async () => {
    const f = await source();
    const hold = latch();
    const original = globalThis.fetch;
    globalThis.fetch = Object.assign(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url) !== `${VENDOR}/token`) return original(url, init);
      await hold.pause();
      const response = await original(url, init);
      await response.text();
      throw new Error('fixture connection lost after refresh');
    }, { preconnect: original.preconnect });
    try {
      const local = f.tool();
      await hold.reached;
      const move = f.move('move');
      await until(() => !localMigrationEnabled(SOURCE, f.dir));
      hold.release();
      await local;
      expect(await move).toMatchObject({ phase: 'freezing', reason: 'local_refresh_uncertain' });
      expect(await f.held.db1.$count(connectors)).toBe(0);
      expect(readLocalConnectors(f.dir)[0]?.config.auth).toMatchObject({ accessToken: LOCAL_ACCESS });
    } finally { hold.release(); globalThis.fetch = original; }
    await f.restart();
    expect((await f.tool()).status).toBe(409);
    expect((await f.status()).migrations[0]?.reason).toBe('local_refresh_uncertain');
    expect(await f.move('resolve')).toMatchObject({ phase: 'rolled_back', reason: 'sign_in' });
    expect(readLocalConnectors(f.dir)[0]?.config.auth).toEqual({ kind: 'none' });
    expect(f.vendor.oauth.tokenCalls).toBe(1);
    expect(await f.held.db1.$count(connectorAgents)).toBe(0);
  });

  test('confirmed abort before central handover resumes the unchanged local grant', async () => {
    const f = fixture = await migrationE2E('oauth-dynamic');
    await f.setSync(true);
    const before = readFileSync(join(f.dir, 'connectors.json'), 'utf8');
    f.faults.drop = 'begin';
    expect((await f.action('move')).status).toBe(503);
    expect(await f.move('rollback')).toMatchObject({ phase: 'rolled_back', reason: null });
    expect(readFileSync(join(f.dir, 'connectors.json'), 'utf8')).toBe(before);
    expect(localMigrationEnabled(SOURCE, f.dir)).toBe(true);
    expect((await f.tool()).status).toBe(200);
    expect(f.vendor.oauth.tokenCalls).toBe(0);
  });

  test('lost ownership reply cannot abort to stale local credentials', async () => {
    const f = fixture = await migrationE2E('oauth-dynamic');
    await f.setSync(true);
    f.faults.drop = 'handover';
    expect((await f.action('move')).status).toBe(503);
    const refusal = await f.move('rollback');
    expect(refusal).toMatchObject({ grantImported: true, reason: 'finish_forward', phase: 'prepared' });
    expect(localMigrationEnabled(SOURCE, f.dir)).toBe(false);
    expect((await f.move('move')).phase).toBe('active');
    expect(await f.held.db1.$count(connectors)).toBe(1);
  });
  test('aborting a still-draining freeze remains resumable after the rollback wait', async () => {
    const f = fixture = await migrationE2E('oauth-dynamic');
    await f.setSync(true);
    const original = readFileSync(join(f.dir, 'connectors.json'), 'utf8');
    const stream = await f.tool('hold'); const body = stream.text(); await f.vendor.held();
    expect(await f.move('move')).toMatchObject({ phase: 'freezing', reason: 'waiting_for_local' });
    expect(await f.move('rollback')).toMatchObject({ phase: 'rollback', reason: 'waiting_for_local' });
    f.vendor.release(); await body;
    await f.restart();
    expect(await f.move('reconcile')).toMatchObject({ phase: 'rolled_back', reason: null });
    expect(readFileSync(join(f.dir, 'connectors.json'), 'utf8')).toBe(original);
    expect((await f.tool()).status).toBe(200);
    expect(await f.held.db1.$count(connectors)).toBe(0);
  }, 20_000);

  for (const boundary of ['before_discard', 'after_receipt_clear'] as const) {
    test(`uncertain local-grant recovery resumes at ${boundary} without reopening stale credentials`, async () => {
      const f = fixture = await migrationE2E('oauth-dynamic');
      await f.setSync(true); f.faults.drop = 'begin';
      expect((await f.action('move')).status).toBe(503);
      await f.move('rollback');
      const record = migrationRecord(SOURCE, f.dir);
      if (record === null) throw new Error('missing durable operation');
      writeFileSync(join(f.dir, `connector-migration-operations-${SOURCE}.json`), JSON.stringify({ version: 1, pending: [`r${'b'.repeat(32)}`] }));
      const receipt = migrationUncertaintyReceipt(SOURCE, f.dir);
      if (receipt === null) throw new Error('missing simulated refresh receipt');
      saveMigration({ ...record, phase: 'recovering', captured: false, recoveryReceipt: receipt }, f.dir);
      if (boundary === 'after_receipt_clear') {
        const rows = readLocalConnectors(f.dir);
        const row = rows.find((value) => value.id === SOURCE);
        if (row === undefined) throw new Error('missing source');
        row.config.auth = { kind: 'none' };
        writeFileSync(join(f.dir, 'connectors.json'), JSON.stringify({ version: 1, connectors: rows }));
        expect(resolveMigrationUncertainty(SOURCE, receipt, f.dir)).toBe(true);
      }
      await f.restart();
      expect((await f.tool()).status).toBe(409);
      expect(await f.move('reconcile')).toMatchObject({ phase: 'rolled_back', reason: 'sign_in' });
      expect(readLocalConnectors(f.dir)[0]?.config.auth).toEqual({ kind: 'none' });
      expect(migrationUncertaintyReceipt(SOURCE, f.dir)).toBeNull();
      expect(f.vendor.oauth.tokenCalls).toBe(0);
    });
  }

});
