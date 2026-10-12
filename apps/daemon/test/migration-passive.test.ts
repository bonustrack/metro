import { afterEach, beforeEach, expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beginLocalMigrationOperation } from '../src/connectors/migration-guard.js';
import { migrationUncertaintyReceipt } from '../src/connectors/migration-operations.js';
import { isolatePassiveTests, passiveFixture, SOURCE, type PassiveFixture } from './migration-passive-fixture.js';
import { within } from './org-sync-control-fixture.js';

let restore: () => void;
let cleanup: (() => Promise<void>) | undefined;
let f: PassiveFixture;
beforeEach(async () => { restore = isolatePassiveTests(); cleanup = undefined; f = await passiveFixture(); cleanup = f.close; });
afterEach(async () => { try { await cleanup?.(); } finally { restore(); } });

const notice = 'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/tools/list_changed"}\n\n';

for (const initial of ['', ': idle\n\n', notice]) {
  test(`Move drains a passive ${initial === '' ? 'empty' : initial.startsWith(':') ? 'comment-only' : 'notification'} GET without discarding journals`, async () => {
    f.configure(initial);
    const stream = await f.start();
    expect(f.idle()).toBe(false);
    const source = f.readSource();
    const record = (await within(f.move())).migrations[0]!;
    expect(record).toMatchObject({ phase: 'active', reason: null, uncertainty: null });
    expect(await within(stream.text)).toBe(initial);
    expect(f.idle()).toBe(true);
    expect(f.readSource()).toBe(source);
    expect(JSON.parse(f.journal())).toEqual({ version: 1, pending: [] });
    expect(f.controls.creates).toBe(1); expect(f.controls.assignments).toBe(1);
    expect((await f.move()).migrations[0]).toEqual(record);
    expect(f.controls.creates).toBe(1); expect(f.controls.assignments).toBe(1);
    expect(f.requests).toHaveLength(1);
  });
}

test('an empty mixed-case SSE response establishes before Move drains it', async () => {
  f.configure('', 'Text/Event-Stream; charset=utf-8');
  const stream = await f.start();
  expect((await within(stream.response)).status).toBe(200);
  expect(stream.remote.destroyed).toBe(false);
  expect((await within(f.move())).migrations[0]?.phase).toBe('active');
  expect(await within(stream.text)).toBe('');
});

test('all passive listeners drain together without touching another source or directory', async () => {
  const other = beginLocalMigrationOperation('other000001', f.dir);
  const elsewhere = beginLocalMigrationOperation(SOURCE, join(f.dir, 'elsewhere'));
  try {
    const first = await f.start(); const second = await f.start();
    expect((await within(f.move())).migrations[0]?.phase).toBe('active');
    expect(await within(first.text)).toBe(': listener\n\n');
    expect(await within(second.text)).toBe(': listener\n\n');
    other.check(); elsewhere.check();
    expect(f.requests).toHaveLength(2);
  } finally { other.close(); elsewhere.close(); }
});

test('Prepare alone leaves the listener open, a frozen source refuses reconnects, and closure reaches the vendor', async () => {
  const stream = await f.start();
  await f.control.run(SOURCE, 'prepare', f.status.scope, null);
  expect(f.idle()).toBe(false);
  expect(stream.remote.destroyed).toBe(false);
  const closed = new Promise<void>((resolve) => { stream.remote.once('close', resolve); });
  const moving = f.move();
  expect((await f.request()).status).toBe(409);
  expect((await within(moving)).migrations[0]?.phase).toBe('active');
  await within(closed); await within(stream.text);
  expect(f.requests).toHaveLength(1);
});

test('a real POST stream survives the drain timeout and Retry keeps the same operation', async () => {
  const listener = await f.start();
  f.configure('data: {"jsonrpc":"2.0","method":"notifications/progress","params":{"progressToken":1,"progress":0}}\n\n');
  const tool = await f.start({ method: 'POST', body: '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"write"}}' });
  const first = (await f.move()).migrations[0]!;
  expect(first).toMatchObject({ phase: 'freezing', reason: 'waiting_for_local', destinationId: null });
  expect(tool.remote.destroyed).toBe(false); expect(listener.remote.destroyed).toBe(false);
  expect(f.controls.creates).toBe(0);
  expect((JSON.parse(f.journal()) as { pending: string[] }).pending).toHaveLength(1);
  const second = (await f.move()).migrations[0]!;
  expect(second).toEqual(first);
  expect(f.requests).toHaveLength(2); expect(f.controls.creates).toBe(0);
  tool.remote.end('data: {"jsonrpc":"2.0","id":1,"result":{}}\n\n');
  expect(await within(tool.text)).toContain('"result":{}');
  expect((await within(f.move())).migrations[0]).toMatchObject({ id: first.id, phase: 'active' });
  expect(await within(listener.text)).toBe(': listener\n\n');
  expect(f.controls.creates).toBe(1); expect(f.controls.assignments).toBe(1);
  expect(migrationUncertaintyReceipt(SOURCE, f.dir)).toBeNull();
}, 30_000);

for (const kind of ['client operation', 'token refresh'] as const) {
  test(`a ${kind} protects the passive GET until the operation closes and refresh is persisted`, async () => {
    const listener = await f.start();
    const operation = beginLocalMigrationOperation(SOURCE, f.dir);
    const response = await operation.dispatch(() => Promise.resolve(new Response('{}')), { effectful: kind === 'token refresh', refresh: kind === 'token refresh' });
    await f.freeze();
    expect(f.idle()).toBe(false);
    expect(listener.remote.destroyed).toBe(false);
    await response.text();
    expect(f.idle()).toBe(false);
    if (kind === 'token refresh') {
      expect((JSON.parse(f.journal()) as { pending: string[] }).pending).toHaveLength(1);
      operation.persistedRefresh();
      expect((JSON.parse(f.journal()) as { pending: string[] }).pending).toEqual([]);
    }
    operation.close(); operation.close();
    expect(f.idle()).toBe(false);
    await within(listener.text);
    expect(f.idle()).toBe(true);
  });
}

const protectedStreams = [
  { name: 'resume cursor', initial: ': idle\n\n', headers: { 'last-event-id': 'post-stream-cursor' } },
  { name: 'outgoing cursor', initial: 'id: next\ndata: \n\n' },
  { name: 'server request', initial: 'data: {"jsonrpc":"2.0","id":3,"method":"sampling/createMessage","params":{}}\n\n' },
  { name: 'server response', initial: 'data: {"jsonrpc":"2.0","id":3,"result":{}}\n\n' },
  { name: 'unknown notification', initial: 'data: {"jsonrpc":"2.0","method":"notifications/custom"}\n\n' },
  { name: 'unknown frame', initial: 'event: endpoint\ndata: /messages\n\n' },
  { name: 'malformed data', initial: 'data: started\n\n' },
  { name: 'missing JSON-RPC version', initial: 'data: {"method":"notifications/tools/list_changed"}\n\n' },
  { name: 'wrong JSON-RPC version', initial: 'data: {"jsonrpc":"1.0","method":"notifications/tools/list_changed"}\n\n' },
  { name: 'unknown envelope field', initial: 'data: {"jsonrpc":"2.0","method":"notifications/tools/list_changed","extra":true}\n\n' },
  { name: 'partial frame', initial: 'data: {"jsonrpc":"2.0"' },
  { name: 'non-SSE GET', initial: 'partial', type: 'application/json' },
  { name: 'failed GET', initial: ': error\n\n', status: 500 },
  { name: 'control POST stream', initial: ': idle\n\n', method: 'POST', body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' },
];
for (const { name, initial, headers, type, status, method, body } of protectedStreams) {
  test(`${name} stays protected and is forwarded byte for byte`, async () => {
    f.configure(initial, type, status);
    const stream = await f.start({ headers, method, body });
    await f.freeze();
    expect(f.idle()).toBe(false);
    expect(stream.remote.destroyed).toBe(false);
    stream.remote.end();
    expect(await within(stream.text)).toBe(initial);
    expect(f.idle()).toBe(true);
  });
}

test('a partial known notification becomes drainable only after its complete frame is forwarded', async () => {
  f.configure(notice.slice(0, -2));
  const stream = await f.start();
  await f.freeze();
  expect(f.idle()).toBe(false);
  stream.remote.write('\n\n');
  await new Promise((resolve) => { setTimeout(resolve, 30); });
  f.idle();
  expect(await within(stream.text)).toBe(notice);
  expect(f.idle()).toBe(true);
});

test('keepalives cannot splice a partial passive notification before drain', async () => {
  const previous = process.env.METRO_RELAY_KEEPALIVE_MS;
  process.env.METRO_RELAY_KEEPALIVE_MS = '10';
  try {
    const split = notice.indexOf('list_changed') + 4;
    f.configure(notice.slice(0, split));
    const stream = await f.start();
    await new Promise((resolve) => { setTimeout(resolve, 50); });
    await f.freeze();
    expect(f.idle()).toBe(false);
    stream.remote.write(notice.slice(split));
    expect((await within(f.move())).migrations[0]?.phase).toBe('active');
    expect((await within(stream.text)).startsWith(notice)).toBe(true);
  } finally {
    if (previous === undefined) delete process.env.METRO_RELAY_KEEPALIVE_MS;
    else process.env.METRO_RELAY_KEEPALIVE_MS = previous;
  }
});

for (const refresh of [false, true]) {
  test(`unknown ${refresh ? 'refresh' : 'request'} outcomes survive passive drain and Retry until explicit settlement`, async () => {
    if (refresh) { await f.close(); cleanup = undefined; f = await passiveFixture(true); cleanup = f.close; }
    const stream = await f.start();
    const operation = beginLocalMigrationOperation(SOURCE, f.dir);
    await expect(operation.dispatch(() => Promise.reject(new Error('fixture lost request')), { refresh })).rejects.toThrow('lost request');
    await f.freeze(); operation.close();
    const source = f.readSource();
    const journal = f.journal();
    const receipt = migrationUncertaintyReceipt(SOURCE, f.dir);
    expect(receipt).not.toBeNull();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect((await f.move()).migrations[0]).toMatchObject({ phase: 'freezing', reason: refresh ? 'local_refresh_uncertain' : 'requests_uncertain', uncertainty: receipt });
      expect(f.idle()).toBe(false); expect(f.journal()).toBe(journal); expect(f.readSource()).toBe(source);
    }
    await within(stream.text);
    expect(f.idle()).toBe(false); expect(f.journal()).toBe(journal);
    const record = f.control.status().migrations[0]!;
    await expect(f.control.run(SOURCE, 'resolve', f.status.scope, record.id, 'invalid')).rejects.toThrow('receipt changed');
    expect(f.journal()).toBe(journal);
    const settled = await f.control.run(SOURCE, 'resolve', f.status.scope, record.id, receipt);
    expect(migrationUncertaintyReceipt(SOURCE, f.dir)).toBeNull();
    expect(JSON.parse(f.journal())).toEqual({ version: 1, pending: [] });
    if (refresh) {
      expect(settled.migrations[0]).toMatchObject({ phase: 'rolled_back', reason: 'sign_in' });
      expect(f.readSource()).not.toContain('access-fixture-secret');
      expect(f.readSource()).not.toContain('refresh-fixture-secret');
      expect(f.controls.rollbacks).toBe(1);
    } else {
      expect(f.readSource()).toBe(source);
      expect((await within(f.move())).migrations[0]).toMatchObject({ id: record.id, phase: 'active' });
    }
  });
}

for (const action of ['move', 'rollback', 'resolve'] as const) {
  test(`${action} can drain a passive listener after a POST fails during local rollback without settling its receipt`, async () => {
    const listener = await f.start();
    const tool = await f.start({ method: 'POST', body: '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"write"}}' });
    await f.freeze();
    const record = f.control.status().migrations[0]!;
    expect((await f.control.run(SOURCE, 'rollback', f.status.scope, record.id)).migrations[0]).toMatchObject({ phase: 'rollback', reason: 'waiting_for_local' });
    expect(listener.remote.destroyed).toBe(false);
    tool.remote.destroy();
    expect(await within(tool.text)).toBe(': listener\n\n');
    const receipt = migrationUncertaintyReceipt(SOURCE, f.dir);
    const journal = f.journal();
    const source = f.readSource();
    expect(receipt).not.toBeNull();
    const retry = f.control.run(SOURCE, action, f.status.scope, record.id, action === 'resolve' ? receipt : null);
    if (action === 'resolve') await expect(retry).rejects.toThrow('still running');
    else expect((await retry).migrations[0]).toMatchObject({ phase: 'rollback', reason: 'requests_uncertain', uncertainty: receipt });
    await within(listener.text);
    expect(f.journal()).toBe(journal); expect(f.readSource()).toBe(source);
    expect(f.controls.rollbacks).toBe(0);
    await f.control.run(SOURCE, 'resolve', f.status.scope, record.id, receipt);
    expect((await f.control.run(SOURCE, 'rollback', f.status.scope, record.id)).migrations[0]?.phase).toBe('rolled_back');
    expect(f.controls.rollbacks).toBe(1);
  });
}

test('explicit uncertain-refresh recovery drains only the passive lease after local rollback', async () => {
  await f.close(); cleanup = undefined; f = await passiveFixture(true); cleanup = f.close;
  const listener = await f.start();
  const operation = beginLocalMigrationOperation(SOURCE, f.dir);
  const sent = Promise.withResolvers<Response>();
  const request = operation.dispatch(() => sent.promise, { refresh: true });
  await f.freeze();
  const record = f.control.status().migrations[0]!;
  expect((await f.control.run(SOURCE, 'rollback', f.status.scope, record.id)).migrations[0]?.reason).toBe('waiting_for_local');
  sent.reject(new Error('fixture lost refresh'));
  await expect(request).rejects.toThrow('lost refresh'); operation.close();
  const receipt = migrationUncertaintyReceipt(SOURCE, f.dir);
  const journal = f.journal();
  expect(receipt).not.toBeNull();
  await expect(f.control.run(SOURCE, 'resolve', f.status.scope, record.id, receipt)).rejects.toThrow('must stop');
  await within(listener.text);
  expect(f.journal()).toBe(journal); expect(f.controls.rollbacks).toBe(0);
  expect((await f.control.run(SOURCE, 'resolve', f.status.scope, record.id, receipt)).migrations[0]).toMatchObject({ phase: 'rolled_back', reason: 'sign_in' });
  expect(f.readSource()).not.toContain('access-fixture-secret');
  expect(f.readSource()).not.toContain('refresh-fixture-secret');
  expect(f.controls.rollbacks).toBe(1);
});

test('a broken journal cannot be bypassed by terminating passive listeners', async () => {
  const stream = await f.start();
  await f.freeze();
  const path = join(f.dir, `connector-migration-operations-${SOURCE}.json`);
  const journal = readFileSync(path, 'utf8');
  writeFileSync(path, 'bad fixture journal');
  expect(() => f.idle()).toThrow('cannot be read');
  expect(stream.remote.destroyed).toBe(false);
  writeFileSync(path, journal);
  f.idle(); await within(stream.text); expect(f.idle()).toBe(true);
});

test('a lost central reply after passive drain reconciles without a second destination or tool dispatch', async () => {
  const stream = await f.start();
  f.controls.drop = 'prepare';
  await expect(f.move()).rejects.toThrow('not confirmed');
  await within(stream.text);
  expect(f.controls.creates).toBe(1);
  expect((await within(f.move())).migrations[0]?.phase).toBe('active');
  expect(f.controls.creates).toBe(1); expect(f.controls.assignments).toBe(1);
  expect(f.requests).toHaveLength(1);
});
