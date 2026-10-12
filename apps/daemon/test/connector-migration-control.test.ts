import { afterEach, expect, test } from 'bun:test';
import { readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { migrationRecord, migrationRecords } from '../src/connectors/migration-state.ts';
import { migrationPayload } from '../src/connectors/migration-source.ts';
import { migrationSource } from '../src/connectors/migration-preview.ts';
import { migrationFixture, SOURCE } from './migration-control-fixture.ts';

const dirs: string[] = [];
const fixture = (oauth = false) => { const f = migrationFixture(oauth); dirs.push(f.dir); return f; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

test('prepare seals existing header and URL settings, preserves policy and persists only protected identity metadata', async () => {
  const f = fixture();
  const before = f.readSource();
  const result = await f.control().run(SOURCE, 'prepare', f.status.scope, migrationRecord(SOURCE, f.dir)?.id ?? null);
  expect(result.migrations[0]).toMatchObject({ phase: 'prepared', reason: null });
  expect(f.controls).toMatchObject({ creates: 1, assignments: 0 });
  expect(f.payload()).toMatchObject({ auth: { kind: 'header', name: 'X-Test-Key', value: 'header-fixture-secret' }, policy: f.source.config.policy, url: f.source.url });
  expect(f.readSource()).toBe(before);
  expect(statSync(join(f.dir, 'connector-migrations.json')).mode & 0o777).toBe(0o600);
  const exposed = JSON.stringify([result, f.requests, readFileSync(join(f.dir, 'connector-migrations.json'), 'utf8')]);
  for (const secret of ['header-fixture-secret', 'url-fixture-secret', '/private', 'X-Test-Key']) expect(exposed).not.toContain(secret);
  expect(JSON.stringify(result)).not.toContain('sourceStamp');
  expect(JSON.stringify(result)).not.toContain('keyId');
});

test('OAuth preparation never copies old rotating tokens or dynamic client credentials', async () => {
  const f = fixture(true);
  await f.control().run(SOURCE, 'prepare', f.status.scope, migrationRecord(SOURCE, f.dir)?.id ?? null);
  expect(f.payload()).toMatchObject({ auth: { kind: 'oauth' }, client: { clientId: 'manual-client', clientSecret: 'manual-fixture-secret' } });
  for (const secret of ['access-fixture-secret', 'refresh-fixture-secret', 'local-dynamic-client']) expect(JSON.stringify(f.payload())).not.toContain(secret);
  expect(migrationRecord(SOURCE, f.dir)).toMatchObject({ phase: 'prepared', reason: 'sign_in' });
  await f.control().run(SOURCE, 'cutover', f.status.scope, migrationRecord(SOURCE, f.dir)?.id ?? null);
  expect(f.controls.assignments).toBe(0);
  expect(migrationRecord(SOURCE, f.dir)?.phase).toBe('prepared');
  f.ready();
  await f.control().run(SOURCE, 'cutover', f.status.scope, migrationRecord(SOURCE, f.dir)?.id ?? null);
  expect(migrationRecord(SOURCE, f.dir)?.phase).toBe('active');
  await f.control().run(SOURCE, 'rollback', f.status.scope, migrationRecord(SOURCE, f.dir)?.id ?? null);
  expect(migrationRecord(SOURCE, f.dir)).toMatchObject({ phase: 'rolled_back', reason: 'sign_in' });
  expect(f.readSource()).not.toContain('refresh-fixture-secret');
  expect(f.readSource()).not.toContain('access-fixture-secret');
  expect(JSON.parse(f.readSource()).connectors[0].config.policy).toEqual(f.source.config.policy);
});

test('lost prepare response reconciles the recorded destination without copying again', async () => {
  const f = fixture();
  f.controls.drop = 'prepare';
  await expect(f.control().run(SOURCE, 'prepare', f.status.scope, migrationRecord(SOURCE, f.dir)?.id ?? null)).rejects.toThrow('not confirmed');
  const id = migrationRecord(SOURCE, f.dir)?.id;
  expect(migrationRecord(SOURCE, f.dir)?.phase).toBe('preparing');
  expect(f.controls.creates).toBe(1);
  await f.control().run(SOURCE, 'reconcile', f.status.scope, migrationRecord(SOURCE, f.dir)?.id ?? null);
  expect(migrationRecord(SOURCE, f.dir)).toMatchObject({ id, phase: 'prepared' });
  expect(f.controls.creates).toBe(1);
});

test('cutover waits for existing local work and verified memory receipt before enabling one path', async () => {
  const f = fixture();
  await f.control().run(SOURCE, 'prepare', f.status.scope, migrationRecord(SOURCE, f.dir)?.id ?? null);
  f.controls.localIdle = false;
  await f.control().run(SOURCE, 'cutover', f.status.scope, migrationRecord(SOURCE, f.dir)?.id ?? null);
  expect(migrationRecord(SOURCE, f.dir)).toMatchObject({ phase: 'cutover', reason: 'waiting_for_local' });
  expect(f.controls.assignments).toBe(0);
  f.controls.localIdle = true;
  f.controls.freshFail = true;
  await expect(f.control().run(SOURCE, 'reconcile', f.status.scope, migrationRecord(SOURCE, f.dir)?.id ?? null)).rejects.toThrow('Fresh organization delivery');
  expect(migrationRecord(SOURCE, f.dir)?.phase).toBe('cutover');
  expect(f.controls.assignments).toBe(1);
  f.controls.freshFail = false;
  await f.control().run(SOURCE, 'reconcile', f.status.scope, migrationRecord(SOURCE, f.dir)?.id ?? null);
  expect(migrationRecord(SOURCE, f.dir)?.phase).toBe('active');
  expect(f.controls.assignments).toBe(1);
});

test('lost activation and rollback responses remain fenced and resume after daemon reconstruction', async () => {
  const f = fixture();
  await f.control().run(SOURCE, 'prepare', f.status.scope, migrationRecord(SOURCE, f.dir)?.id ?? null);
  f.controls.drop = 'activate';
  await expect(f.control().run(SOURCE, 'cutover', f.status.scope, migrationRecord(SOURCE, f.dir)?.id ?? null)).rejects.toThrow('not confirmed');
  expect(migrationRecord(SOURCE, f.dir)?.phase).toBe('cutover');
  await f.control().run(SOURCE, 'reconcile', f.status.scope, migrationRecord(SOURCE, f.dir)?.id ?? null);
  expect(migrationRecord(SOURCE, f.dir)?.phase).toBe('active');
  expect(f.controls.assignments).toBe(1);
  f.controls.orgIdle = false;
  await f.control().run(SOURCE, 'rollback', f.status.scope, migrationRecord(SOURCE, f.dir)?.id ?? null);
  expect(migrationRecord(SOURCE, f.dir)?.phase).toBe('rollback');
  expect(f.controls.rollbacks).toBe(0);
  f.controls.orgIdle = true;
  f.controls.drop = 'rollback';
  await expect(f.control().run(SOURCE, 'reconcile', f.status.scope, migrationRecord(SOURCE, f.dir)?.id ?? null)).rejects.toThrow('not confirmed');
  expect(f.controls.restored).toBe(0);
  await f.control().run(SOURCE, 'reconcile', f.status.scope, migrationRecord(SOURCE, f.dir)?.id ?? null);
  expect(migrationRecord(SOURCE, f.dir)?.phase).toBe('rolled_back');
  expect(f.controls.rollbacks).toBe(1);
  expect(f.controls.restored).toBe(1);
});

test('policy edits, disabled sync and stale operation scopes cannot cut over', async () => {
  const f = fixture();
  await f.control().run(SOURCE, 'prepare', f.status.scope, migrationRecord(SOURCE, f.dir)?.id ?? null);
  f.status.enabled = false;
  await expect(f.control().run(SOURCE, 'cutover', f.status.scope, migrationRecord(SOURCE, f.dir)?.id ?? null)).rejects.toThrow('Enable organization');
  f.status.enabled = true;
  await expect(f.control().run(SOURCE, 'cutover', 'b'.repeat(64), migrationRecord(SOURCE, f.dir)?.id ?? null)).rejects.toThrow('changed');
  writeFileSync(join(f.dir, 'connectors.json'), JSON.stringify({ version: 1, connectors: [{ ...f.source, config: { ...f.source.config, policy: { write: 'allow' } } }] }));
  await expect(f.control().run(SOURCE, 'cutover', f.status.scope, migrationRecord(SOURCE, f.dir)?.id ?? null)).rejects.toThrow('retained local connector changed');
  expect(f.controls.assignments).toBe(0);
  expect(migrationRecord(SOURCE, f.dir)?.phase).toBe('prepared');
});

test('a delayed request after an owner scope change cannot save success or affect the new account', async () => {
  const f = fixture();
  let release: () => void = () => {};
  f.controls.pause = new Promise<void>((resolve) => { release = resolve; });
  const control = f.control();
  const request = control.run(SOURCE, 'prepare', f.status.scope, migrationRecord(SOURCE, f.dir)?.id ?? null);
  await expect(control.run(SOURCE, 'prepare', f.status.scope, migrationRecord(SOURCE, f.dir)?.id ?? null)).rejects.toThrow('still running');
  f.status.scope = 'b'.repeat(64);
  release();
  await expect(request).rejects.toThrow('changed');
  expect(migrationRecord(SOURCE, f.dir)?.phase).toBe('preparing');
  f.controls.pause = null;
  await f.control().run(SOURCE, 'reconcile', f.status.scope, migrationRecord(SOURCE, f.dir)?.id ?? null);
  expect(migrationRecord(SOURCE, f.dir)?.phase).toBe('prepared');
});

test('corrupt protected mapping fails closed and is never normalized into empty state', () => {
  const f = fixture();
  writeFileSync(join(f.dir, 'connector-migrations.json'), '{broken-secret');
  expect(() => f.control().status()).toThrow('Protected connector migration records');
  expect(() => migrationRecords(f.dir)).toThrow('Protected connector migration records');
  expect(readFileSync(join(f.dir, 'connector-migrations.json'), 'utf8')).toBe('{broken-secret');
});

test('OAuth credential refresh cannot change the static source stamp and unsupported configurations block explicitly', () => {
  const f = fixture(true);
  const before = migrationPayload(migrationSource(SOURCE, f.dir));
  writeFileSync(join(f.dir, 'connectors.json'), JSON.stringify({ version: 1, connectors: [{ ...f.source, config: { ...f.source.config, auth: { ...f.source.config.auth, accessToken: 'rotated-access', refreshToken: 'rotated-refresh' } } }] }));
  expect(migrationPayload(migrationSource(SOURCE, f.dir)).sourceStamp).toBe(before.sourceStamp);
  writeFileSync(join(f.dir, 'connectors.json'), JSON.stringify({ version: 1, connectors: [{ ...f.source, config: { ...f.source.config, oauth: false, auth: { kind: 'none' } } }] }));
  expect(() => migrationSource(SOURCE, f.dir)).toThrow('preview blockers');
});
