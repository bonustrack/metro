import { afterEach, beforeEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beginLocalMigrationOperation, localMigrationIdle } from '../src/connectors/migration-guard.ts';
import { captureMigrationOperations, migrationRequestEffectful, migrationUncertaintyReceipt, resolveMigrationUncertainty } from '../src/connectors/migration-operations.ts';
import { localRelayTarget } from '../src/connectors/store.ts';
import { migration, SOURCE } from './migration-guard-fixture.ts';

let dir = '';
const journal = () => join(dir, `connector-migration-operations-${SOURCE}.json`);
const receipt = (): string => {
  const value = migrationUncertaintyReceipt(SOURCE, dir);
  if (value === null) throw new Error('expected an uncertain request');
  return value;
};

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'metro-migration-operations-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

test('Prepare captures a preexisting dispatched request and abort stays fenced after its lease closes', async () => {
  let body: ReadableStreamDefaultController<Uint8Array> | undefined;
  const operation = beginLocalMigrationOperation(SOURCE, dir);
  const other = beginLocalMigrationOperation(SOURCE, dir);
  const response = await operation.dispatch(() => Promise.resolve(new Response(new ReadableStream<Uint8Array>({ start(controller) { body = controller; controller.enqueue(new TextEncoder().encode('partial')); } }))));
  const result = response.text().then(() => null, (error: unknown) => error);
  expect(existsSync(journal())).toBe(false);
  migration(dir, 'preparing');
  expect(migrationUncertaintyReceipt(SOURCE, dir)).toBeNull();
  expect(localMigrationIdle(SOURCE, dir)).toBe(false);
  body?.error(new Error('client disconnected'));
  expect(String(await result)).toContain('client disconnected');
  operation.close();
  const unknown = receipt();
  expect(resolveMigrationUncertainty(SOURCE, unknown, dir)).toBe(false);
  other.close();
  expect(localMigrationIdle(SOURCE, dir)).toBe(false);
  expect(() => beginLocalMigrationOperation(SOURCE, dir)).toThrow('unknown outcome');
  await expect(localRelayTarget(SOURCE, false, dir)).rejects.toThrow('unknown outcome');
  expect(resolveMigrationUncertainty(SOURCE, 'stale', dir)).toBe(false);
  expect(resolveMigrationUncertainty(SOURCE, unknown, dir)).toBe(true);
  expect(migrationUncertaintyReceipt(SOURCE, dir)).toBeNull();
  expect(localMigrationIdle(SOURCE, dir)).toBe(true);
});

test('a failure still within a pre-Prepare lease is captured as unknown rather than forgotten', async () => {
  const operation = beginLocalMigrationOperation(SOURCE, dir);
  await expect(operation.dispatch(() => Promise.reject(new Error('socket failed')))).rejects.toThrow('socket failed');
  expect(existsSync(journal())).toBe(false);
  migration(dir, 'preparing');
  expect(receipt()).toHaveLength(64);
  operation.close();
  expect(resolveMigrationUncertainty(SOURCE, receipt(), dir)).toBe(true);
});

test('successful complete response clears its durable ID but the enclosing operation still drains', async () => {
  migration(dir, 'prepared');
  let body: ReadableStreamDefaultController<Uint8Array> | undefined;
  const operation = beginLocalMigrationOperation(SOURCE, dir);
  const response = await operation.dispatch(() => Promise.resolve(new Response(new ReadableStream<Uint8Array>({ start(controller) { body = controller; } }))));
  expect((JSON.parse(readFileSync(journal(), 'utf8')) as { pending: string[] }).pending).toHaveLength(1);
  expect(migrationUncertaintyReceipt(SOURCE, dir)).toBeNull();
  const text = response.text();
  body?.enqueue(new TextEncoder().encode('completed'));
  body?.close();
  expect(await text).toBe('completed');
  expect((JSON.parse(readFileSync(journal(), 'utf8')) as { pending: string[] }).pending).toEqual([]);
  expect(localMigrationIdle(SOURCE, dir)).toBe(false);
  operation.close();
  expect(localMigrationIdle(SOURCE, dir)).toBe(true);
});

test('a restarted process sees an unfinished dispatched ID as uncertain without storing payloads', () => {
  migration(dir, 'prepared');
  const guard = new URL('../src/connectors/migration-guard.ts', import.meta.url).href;
  const script = `
    const { beginLocalMigrationOperation } = await import(${JSON.stringify(guard)});
    const operation = beginLocalMigrationOperation(${JSON.stringify(SOURCE)});
    operation.dispatch(() => new Promise(() => {})).catch(() => {});
    process.exit(0);
  `;
  const child = spawnSync(process.execPath, ['--eval', script], { encoding: 'utf8', env: { ...process.env, METRO_AGENTS_DIR: dir } });
  expect(child.status).toBe(0);
  const unknown = receipt();
  expect(localMigrationIdle(SOURCE, dir)).toBe(false);
  expect(statSync(journal()).mode & 0o777).toBe(0o600);
  expect(statSync(`${journal()}.initialized`).mode & 0o777).toBe(0o600);
  const saved = JSON.parse(readFileSync(journal(), 'utf8')) as { version: number; pending: string[] };
  expect(Object.keys(saved).sort()).toEqual(['pending', 'version']);
  expect(saved.pending).toHaveLength(1);
  expect(saved.pending[0]).toMatch(/^[a-f0-9]{32}$/);
  expect(resolveMigrationUncertainty(SOURCE, unknown, dir)).toBe(true);
});

test('a previous acknowledgement never clears a later failed dispatch and none are replayed', async () => {
  migration(dir, 'prepared');
  let sends = 0;
  const fail = () => { sends += 1; return Promise.reject<Response>(new Error('connection lost')); };
  const first = beginLocalMigrationOperation(SOURCE, dir);
  await expect(first.dispatch(fail)).rejects.toThrow('connection lost');
  first.close();
  const old = receipt();
  expect(resolveMigrationUncertainty(SOURCE, old, dir)).toBe(true);
  const second = beginLocalMigrationOperation(SOURCE, dir);
  await expect(second.dispatch(fail)).rejects.toThrow('connection lost');
  second.close();
  expect(receipt()).not.toBe(old);
  expect(resolveMigrationUncertainty(SOURCE, old, dir)).toBe(false);
  expect(sends).toBe(2);
  expect(resolveMigrationUncertainty(SOURCE, receipt(), dir)).toBe(true);
  expect(sends).toBe(2);
});

test('missing journal files cannot reset uncertainty through another phase save', async () => {
  migration(dir, 'prepared');
  const operation = beginLocalMigrationOperation(SOURCE, dir);
  await expect(operation.dispatch(() => Promise.reject(new Error('lost')))).rejects.toThrow('lost');
  operation.close();
  for (const path of [journal(), `${journal()}.initialized`]) {
    const original = readFileSync(path, 'utf8');
    rmSync(path);
    try {
      expect(() => migrationUncertaintyReceipt(SOURCE, dir)).toThrow('cannot be read');
      expect(() => captureMigrationOperations(SOURCE, dir, false)).toThrow('cannot be read');
      expect(() => migration(dir, 'cutover')).toThrow('cannot be read');
    } finally { writeFileSync(path, original, { mode: 0o600 }); }
  }
  expect(resolveMigrationUncertainty(SOURCE, receipt(), dir)).toBe(true);
});

test('known authentication refusal permits the existing refresh retry without uncertainty', async () => {
  migration(dir, 'prepared');
  const operation = beginLocalMigrationOperation(SOURCE, dir);
  for (const status of [401, 403]) {
    const response = await operation.dispatch(() => Promise.resolve(new Response('refused', { status })));
    await response.body?.cancel();
    expect(migrationUncertaintyReceipt(SOURCE, dir)).toBeNull();
  }
  const retried = await operation.dispatch(() => Promise.resolve(new Response('ok')));
  expect(await retried.text()).toBe('ok');
  operation.close();
  expect(localMigrationIdle(SOURCE, dir)).toBe(true);
});

test('only known read and MCP control requests avoid durable uncertainty', () => {
  for (const method of ['GET', 'HEAD', 'DELETE']) expect(migrationRequestEffectful(method, undefined)).toBe(false);
  const rpc = (method: string) => ({ jsonrpc: '2.0', id: 1, method });
  for (const method of ['initialize', 'ping', 'tools/list', 'notifications/initialized', 'notifications/cancelled']) {
    expect(migrationRequestEffectful('POST', JSON.stringify(rpc(method)))).toBe(false);
  }
  for (const body of [JSON.stringify(rpc('tools/call')), JSON.stringify([rpc('tools/list'), rpc('tools/call')]), 'grant_type=refresh_token&refresh_token=secret', '{}', 'bad-json', '[]', undefined]) {
    expect(migrationRequestEffectful('POST', body)).toBe(true);
  }
  expect(migrationRequestEffectful('PATCH', '{}')).toBe(true);
  expect(migrationRequestEffectful('POST', new TextEncoder().encode(JSON.stringify(rpc('tools/call'))))).toBe(true);
});
