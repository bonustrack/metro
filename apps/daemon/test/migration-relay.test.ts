import { afterEach, beforeEach, expect, test } from 'bun:test';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleRelayRequest, type RelayApiDeps } from '../src/connectors/relay.ts';
import { localMigrationIdle } from '../src/connectors/migration-guard.ts';
import { migrationUncertaintyReceipt } from '../src/connectors/migration-operations.ts';
import { close, listen, within } from './org-sync-control-fixture.ts';
import { migration, SOURCE } from './migration-guard-fixture.ts';

let dir = '';
let base = '';
let upstream = '';
let calls = 0;
let openCalls = 0;
let deps: RelayApiDeps;
let vendor: (req: IncomingMessage, res: ServerResponse) => void;
const server = createServer((req, res) => { calls += 1; vendor(req, res); });
const relay = createServer((req, res) => { handleRelayRequest(req, res, deps); });

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'metro-migration-relay-'));
  calls = 0; openCalls = 0;
  vendor = (_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }).end('{}'); };
  upstream = await listen(server);
  base = await listen(relay);
  deps = {
    migrationDir: dir, identify: () => ({ subject: 'fixture', agentId: 'agent000001' }), signedOut: () => {},
    target: () => Promise.resolve({ kind: 'ok', url: upstream, headers: {} }),
    open: () => { openCalls += 1; return null; },
  };
});

afterEach(async () => {
  await close(relay); await close(server);
  rmSync(dir, { recursive: true, force: true });
});

const call = (method = 'GET') => fetch(`${base}/relay/${SOURCE}`, { method, ...(method === 'POST' ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'write_item', arguments: {} } }) } : {}) });

test('cutover drains the complete local stream and normal local ids never open an org session', async () => {
  const held = Promise.withResolvers<ServerResponse>();
  vendor = (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: started\n\n'); held.resolve(res);
  };
  const response = await call();
  const text = response.text();
  const remote = await within(held.promise);
  expect(localMigrationIdle(SOURCE, dir)).toBe(false);
  migration(dir, 'cutover');
  expect((await call()).status).toBe(409);
  expect(localMigrationIdle(SOURCE, dir)).toBe(false);
  expect(calls).toBe(1);
  expect(openCalls).toBe(0);
  remote.end('data: completed\n\n');
  expect(await within(text)).toContain('completed');
  expect(localMigrationIdle(SOURCE, dir)).toBe(true);
});

test('a target resolving after cutover is fenced immediately before vendor dispatch', async () => {
  deps.target = () => {
    migration(dir, 'cutover');
    return Promise.resolve({ kind: 'ok', url: upstream, headers: {} });
  };
  expect((await call('POST')).status).toBe(409);
  expect(calls).toBe(0);
  expect(localMigrationIdle(SOURCE, dir)).toBe(true);
});

test('authentication retry rechecks the fence after its target await', async () => {
  let targets = 0;
  vendor = (_req, res) => { res.writeHead(401).end(); };
  deps.target = (_id, force) => {
    targets += 1;
    if (force) migration(dir, 'cutover');
    return Promise.resolve({ kind: 'ok', url: upstream, headers: {} });
  };
  expect((await call('POST')).status).toBe(409);
  expect(targets).toBe(2);
  expect(calls).toBe(1);
});

test('a prepared source retains its single known authentication refresh retry', async () => {
  migration(dir, 'prepared');
  let targets = 0;
  vendor = (_req, res) => { res.writeHead(calls === 1 ? 401 : 200).end('{}'); };
  deps.target = () => { targets += 1; return Promise.resolve({ kind: 'ok', url: upstream, headers: {} }); };
  const response = await call('POST');
  expect(response.status).toBe(200);
  await response.text();
  expect(targets).toBe(2);
  expect(calls).toBe(2);
  expect(migrationUncertaintyReceipt(SOURCE, dir)).toBeNull();
  expect(localMigrationIdle(SOURCE, dir)).toBe(true);
});

test('an active source uses its session and cannot fall back to the retained local target', async () => {
  migration(dir, 'active');
  let localTargets = 0;
  let closed = 0;
  deps.target = () => { localTargets += 1; return Promise.resolve({ kind: 'ok', url: upstream, headers: {} }); };
  expect((await call('POST')).status).toBe(503);
  expect(localTargets).toBe(0);
  expect(calls).toBe(0);
  deps.open = (id) => {
    expect(id).toBe(SOURCE);
    return {
      target: () => Promise.resolve({ kind: 'ok', url: upstream, headers: {} }),
      current: () => ({ kind: 'ok', url: upstream, headers: {} }),
      blocker: () => (source) => { expect(source).toBe(SOURCE); return null; },
      signal: new AbortController().signal, close: () => { closed += 1; },
    };
  };
  expect((await call('POST')).status).toBe(200);
  expect(localTargets).toBe(0);
  expect(calls).toBe(1);
  expect(closed).toBe(1);
});
