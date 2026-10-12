import { afterEach, beforeEach, expect, test } from 'bun:test';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beginLocalMigrationOperation, localMigrationIdle, migrationExportableRows } from '../src/connectors/migration-guard.ts';
import { localConnectorTools, localCreateConnector, localDeleteConnector, localDisconnectConnector, localImportConnectors, localMarkSignedOut, localReconnectConnector, localRelayTarget, localRenameConnector, localRollbackMigrationSource, localSetConnectorPolicy, localVerifyConnector, readLocalConnectors } from '../src/connectors/store.ts';
import { handleCallback, handleConnect, type OAuthRouteDeps } from '../src/connectors/oauth-routes.ts';
import { startPending } from '../src/connectors/oauth.ts';
import { migrationUncertaintyReceipt } from '../src/connectors/migration-operations.ts';
import { close, listen, within } from './org-sync-control-fixture.ts';
import { migration, SOURCE, SOURCE_NAME } from './migration-guard-fixture.ts';

let dir = '';
let base = '';
let seen: string[] = [];
let handle: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
const server = createServer((req, res) => { handle(req, res).catch(() => { res.writeHead(500).end(); }); });
const oauth = () => ({ kind: 'oauth' as const, issuer: base, tokenEndpoint: `${base}/token`, clientId: 'test-client', accessToken: 'old-access', refreshToken: 'old-refresh', expiresAt: Date.now() - 1 });
const source = () => ({ id: SOURCE, name: SOURCE_NAME, url: `${base}/mcp`, config: { auth: { kind: 'header', name: 'Authorization', value: 'local-secret' } } });
const input = () => ({ name: SOURCE_NAME, url: `${base}/mcp`, header: 'Authorization', value: 'new-secret', clientId: undefined, clientSecret: undefined });

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'metro-migration-guard-'));
  seen = [];
  handle = async (req, res) => {
    seen.push(req.url ?? '');
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ result: { protocolVersion: '2025-11-25', serverInfo: { name: 'fixture' }, tools: [] } }));
    await Promise.resolve();
  };
  base = await listen(server);
  localImportConnectors([source()], dir);
});

afterEach(async () => {
  await close(server);
  rmSync(dir, { recursive: true, force: true });
});

test('preparation locks only source IDs and atomic import replacements while local use continues', async () => {
  for (const phase of ['preparing', 'prepared'] as const) {
    migration(dir, phase);
    const before = readFileSync(join(dir, 'connectors.json'), 'utf8');
    await expect(localRenameConnector(SOURCE, 'new-name', dir)).rejects.toThrow('locked');
    await expect(localDeleteConnector(SOURCE, dir)).rejects.toThrow('locked');
    await expect(localSetConnectorPolicy(SOURCE, {}, dir)).rejects.toThrow('locked');
    await expect(localReconnectConnector(SOURCE, oauth(), dir)).rejects.toThrow('locked');
    expect(() => localImportConnectors([{ ...source(), name: 'Other' }], dir)).toThrow('locked');
    expect(readFileSync(join(dir, 'connectors.json'), 'utf8')).toBe(before);
    expect((await localRelayTarget(SOURCE, false, dir)).kind).toBe('ok');
    expect((await localVerifyConnector(SOURCE, dir)).ok).toBe(true);
    expect(await localConnectorTools(SOURCE, dir)).toEqual([]);
    expect(readFileSync(join(dir, 'connectors.json'), 'utf8')).toBe(before);
    expect(migrationExportableRows([source()], dir)).toEqual([]);
  }
});

test('cutover, active, rollback and malformed storage fence all local vendor use', async () => {
  for (const phase of ['cutover', 'active', 'rollback'] as const) {
    migration(dir, phase);
    await expect(localRelayTarget(SOURCE, false, dir)).rejects.toThrow('locked');
    await expect(localVerifyConnector(SOURCE, dir)).rejects.toThrow('locked');
    await expect(localConnectorTools(SOURCE, dir)).rejects.toThrow('locked');
    expect(localMigrationIdle(SOURCE, dir)).toBe(true);
  }
  expect(seen).toEqual([]);
  writeFileSync(join(dir, 'connector-migrations.json'), '{bad');
  await expect(localRelayTarget('local000002', false, dir)).rejects.toThrow('cannot be read');
  expect(() => migrationExportableRows([source()], dir)).toThrow('cannot be read');
});

test('missing initialized ledger or marker fails closed for local targets and exports after restart', async () => {
  const store = new URL('../src/connectors/store.ts', import.meta.url).href;
  const guard = new URL('../src/connectors/migration-guard.ts', import.meta.url).href;
  const script = `
    const { localRelayTarget, readLocalConnectors } = await import(${JSON.stringify(store)});
    const { migrationExportableRows } = await import(${JSON.stringify(guard)});
    const relay = await localRelayTarget(${JSON.stringify(SOURCE)}, false).then(() => 'open', () => 'closed');
    let exported = 'open';
    try { migrationExportableRows(readLocalConnectors()); } catch { exported = 'closed'; }
    process.stdout.write(JSON.stringify([relay, exported]));
  `;
  for (const phase of ['cutover', 'active'] as const) {
    migration(dir, phase);
    for (const file of ['connector-migrations.json', 'connector-migrations.initialized']) {
      const path = join(dir, file);
      const original = readFileSync(path, 'utf8');
      rmSync(path);
      try {
        await expect(localRelayTarget(SOURCE, false, dir)).rejects.toThrow('cannot be read');
        expect(() => migrationExportableRows(readLocalConnectors(dir), dir)).toThrow('cannot be read');
        const restarted = spawnSync(process.execPath, ['--eval', script], { encoding: 'utf8', env: { ...process.env, METRO_AGENTS_DIR: dir } });
        expect(restarted.status).toBe(0);
        expect(restarted.stdout).toBe('["closed","closed"]');
      } finally { writeFileSync(path, original, { mode: 0o600 }); }
    }
  }
  expect(seen).toEqual([]);
});

test('leases are per directory, survive cutover until close, and rolled back sources resume', async () => {
  const operation = beginLocalMigrationOperation(SOURCE, dir);
  const nested = beginLocalMigrationOperation(SOURCE, dir);
  expect(localMigrationIdle(SOURCE, dir)).toBe(false);
  expect(localMigrationIdle(SOURCE, `${dir}/other`)).toBe(true);
  migration(dir, 'cutover');
  expect(() => operation.check()).toThrow('locked');
  expect(() => beginLocalMigrationOperation(SOURCE, dir)).toThrow('locked');
  operation.close(); operation.close();
  expect(localMigrationIdle(SOURCE, dir)).toBe(false);
  nested.close();
  expect(localMigrationIdle(SOURCE, dir)).toBe(true);
  migration(dir, 'rolled_back');
  expect((await localRelayTarget(SOURCE, false, dir)).kind).toBe('ok');
  await localRenameConnector(SOURCE, 'restored', dir);
  expect(migrationExportableRows(readLocalConnectors(dir), dir)).toHaveLength(1);
});

test('refresh already dispatched may save only its rotated auth after cutover', async () => {
  localImportConnectors([{ ...source(), config: { auth: oauth(), oauth: true } }], dir);
  const reached = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  handle = async (req, res) => {
    seen.push(req.url ?? ''); reached.resolve(); await release.promise;
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ access_token: 'rotated-access', refresh_token: 'rotated-refresh', token_type: 'Bearer', expires_in: 3600 }));
  };
  const pending = localRelayTarget(SOURCE, false, dir).then(() => null, (error: unknown) => error);
  await within(reached.promise);
  expect(localMigrationIdle(SOURCE, dir)).toBe(false);
  migration(dir, 'cutover', { auth: 'oauth' });
  await expect(localDisconnectConnector(SOURCE, dir)).rejects.toThrow('locked');
  expect(() => localMarkSignedOut(SOURCE, dir)).toThrow('locked');
  release.resolve();
  expect(String(await pending)).toContain('locked');
  expect(readLocalConnectors(dir)[0]?.config.auth).toMatchObject({ accessToken: 'rotated-access', refreshToken: 'rotated-refresh' });
  expect(seen).toEqual(['/token']);
  expect(localMigrationIdle(SOURCE, dir)).toBe(true);
  expect(() => localRollbackMigrationSource(SOURCE, true, dir)).toThrow('not ready');
  migration(dir, 'rollback', { auth: 'oauth' });
  localRollbackMigrationSource(SOURCE, true, dir);
  expect(readLocalConnectors(dir)[0]?.config).toMatchObject({ auth: { kind: 'none' }, oauth: true });
});

test('discovery cannot dispatch its next request after cutover', async () => {
  handle = async (req, res) => {
    seen.push(req.url ?? '');
    migration(dir, 'cutover');
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ result: { protocolVersion: '2025-11-25' } }));
    await Promise.resolve();
  };
  await expect(localConnectorTools(SOURCE, dir)).rejects.toThrow('locked');
  expect(seen).toEqual(['/mcp']);
  expect(localMigrationIdle(SOURCE, dir)).toBe(true);
});

test('same-name creation and import stay independent from a migrating source', async () => {
  const before = readLocalConnectors(dir)[0];
  handle = async (_req, res) => {
    migration(dir, 'preparing');
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ result: { protocolVersion: '2025-11-25' } }));
    await Promise.resolve();
  };
  const created = await localCreateConnector(input(), dir);
  expect(created.id).not.toBe(SOURCE);
  expect(readLocalConnectors(dir)[0]).toEqual(before);
  localImportConnectors([{ ...source(), id: 'local000002' }], dir);
  expect(migrationExportableRows(readLocalConnectors(dir), dir).map((row) => row.id)).toEqual([created.id, 'local000002']);
  await expect(localRenameConnector(created.id, SOURCE_NAME, dir)).resolves.toMatchObject({ id: created.id });
});

test('OAuth preparation and an older callback cannot sign in a protected source', async () => {
  let lookups = 0;
  const deps: OAuthRouteDeps = {
    migrationDir: dir,
    getConnector: async () => { lookups += 1; throw new Error('must not look up'); },
    createPendingConnector: async () => { throw new Error('unused'); },
    reconnectConnector: (id, auth) => localReconnectConnector(id, auth, dir),
  };
  const ticket = startPending({ connectorId: SOURCE, name: SOURCE_NAME, url: `${base}/mcp`, resource: `${base}/mcp`, returnTo: 'https://metro.box/', verifier: 'test-verifier', server: { issuer: base, tokenEndpoint: `${base}/token`, authorizationEndpoint: `${base}/authorize`, registrationEndpoint: null, scopes: [], supportsS256: true }, client: { clientId: 'test-client' } });
  migration(dir, 'prepared');
  const router = createServer((req, res) => {
    if ((req.url ?? '').startsWith('/callback')) handleCallback(req, res, deps);
    else handleConnect(req, res, deps, SOURCE).catch(() => { res.writeHead(409).end(); });
  });
  const address = await listen(router);
  try {
    expect((await fetch(`${address}/connect`, { method: 'POST', body: '{}' })).status).toBe(409);
    const response = await fetch(`${address}/callback?state=${ticket}&code=test-code`, { redirect: 'manual' });
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toContain('locked');
    expect(seen).toEqual([]);
    expect(lookups).toBe(0);
  } finally { await close(router); }
});

test('prepared anonymous discovery tolerates metadata 404 and drains session DELETE 200', async () => {
  localImportConnectors([{ ...source(), config: { auth: { kind: 'none' } } }], dir);
  migration(dir, 'prepared', { auth: 'none' });
  handle = async (req, res) => {
    seen.push(`${req.method ?? ''} ${req.url ?? ''}`);
    if (req.method === 'GET') { res.writeHead(404).end('{}'); return; }
    if (req.method === 'DELETE') { res.writeHead(200, { 'content-type': 'application/json' }).end('{"closed":true}'); return; }
    req.resume();
    await Promise.resolve();
    res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'fixture-session' }).end(JSON.stringify({ result: { protocolVersion: '2025-11-25', serverInfo: { name: 'fixture' }, tools: [] } }));
  };
  expect((await localVerifyConnector(SOURCE, dir)).ok).toBe(true);
  expect(seen.some((request) => request.startsWith('GET '))).toBe(true);
  expect(await localConnectorTools(SOURCE, dir)).toEqual([]);
  expect(seen).toContain('DELETE /mcp');
  expect(migrationUncertaintyReceipt(SOURCE, dir)).toBeNull();
  expect(localMigrationIdle(SOURCE, dir)).toBe(true);
});

test('a pre-Prepare OAuth ticket stays invalid after rollback while a fresh ticket works', async () => {
  localImportConnectors([{ ...source(), config: { auth: { kind: 'none' }, oauth: true } }], dir);
  const pending = { connectorId: SOURCE, name: SOURCE_NAME, url: `${base}/mcp`, resource: `${base}/mcp`, returnTo: 'https://metro.box/', verifier: 'test-verifier', server: { issuer: base, tokenEndpoint: `${base}/token`, authorizationEndpoint: `${base}/authorize`, registrationEndpoint: null, scopes: [], supportsS256: true }, client: { clientId: 'test-client' } };
  const old = startPending(pending);
  migration(dir, 'preparing', { auth: 'oauth' });
  migration(dir, 'rollback', { auth: 'oauth' });
  localRollbackMigrationSource(SOURCE, true, dir);
  const rolledBack = migration(dir, 'rolled_back', { auth: 'oauth' });
  const deps: OAuthRouteDeps = {
    migrationDir: dir,
    getConnector: async () => { throw new Error('unused'); },
    createPendingConnector: async () => { throw new Error('unused'); },
    reconnectConnector: (id, auth) => localReconnectConnector(id, auth, dir),
  };
  const router = createServer((req, res) => { handleCallback(req, res, deps); });
  const address = await listen(router);
  try {
    const refused = await fetch(`${address}/callback?state=${old}&code=old-code`, { redirect: 'manual' });
    expect(refused.status).toBe(302);
    expect(refused.headers.get('location')).toContain('predates');
    expect(seen).toEqual([]);
    handle = async (req, res) => {
      seen.push(req.url ?? '');
      const result = req.url === '/token' ? { access_token: 'fresh-access', refresh_token: 'fresh-refresh', token_type: 'Bearer', expires_in: 3600 } : { result: { protocolVersion: '2025-11-25' } };
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
      await Promise.resolve();
    };
    const fresh = startPending({ ...pending, migrationId: rolledBack.id });
    const accepted = await fetch(`${address}/callback?state=${fresh}&code=fresh-code`, { redirect: 'manual' });
    expect(accepted.status).toBe(302);
    expect(accepted.headers.get('location')).not.toContain('connector_error');
    expect(seen).toEqual(['/token', '/mcp']);
    expect(readLocalConnectors(dir)[0]?.config.auth).toMatchObject({ kind: 'oauth', accessToken: 'fresh-access' });
  } finally { await close(router); }
});
