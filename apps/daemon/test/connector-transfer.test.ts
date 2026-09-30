import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { createServer, type Server } from 'node:http';
import { randomInt } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setBearerSessions } from '@metro-labs/http/api-http';
import { SigningKeys } from '@metro-labs/http/workos-token';
import { log } from '@metro-labs/core/log';
import { fakeIssuer, sessionClaims, type FakeIssuer } from '../../../packages/http/test/workos-fixture.ts';
import { bearerSessionsFor } from '../src/routes/bearer.ts';
import { handleSessionApis } from '../src/routes/session-apis.ts';
import { ConnectorTransfers } from '../src/connectors/transfer-api.ts';
import { copyConnectorRows } from '../src/connectors/transfer-store.ts';
import { localImportConnectors, readLocalConnectors } from '../src/connectors/store.ts';
import { readConfig } from '../src/connectors/config.ts';

const SOURCE = 'org_01SOURCE000000';
const DESTINATION = 'org_01TARGET000000';
const HEADER_SECRET = 'harmless-header-fixture';
const OAUTH_SECRET = 'harmless-oauth-fixture';
let issuer: FakeIssuer;
let root = '';
let sourceDir = '';
let destinationDir = '';
let sourceApi: ConnectorTransfers;
let destinationApi: ConnectorTransfers;
let sourceBase = '';
let destinationBase = '';
let destinationOwner = DESTINATION;
let now = 1000;
const servers: Server[] = [];

async function serve(owner: () => string, transfers: () => ConnectorTransfers, keys: SigningKeys): Promise<string> {
  const server = createServer((req, res) => {
    setBearerSessions(bearerSessionsFor(owner, keys));
    if (!handleSessionApis(req, res, { connectorTransfers: transfers() })) res.writeHead(404).end();
  });
  const port = randomInt(10000, 30000);
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  servers.push(server);
  return `http://127.0.0.1:${String(port)}`;
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'metro-connector-copy-'));
  sourceDir = join(root, 'source');
  destinationDir = join(root, 'destination');
  issuer = await fakeIssuer();
  const keys = new SigningKeys(issuer.url);
  sourceBase = await serve(() => SOURCE, () => sourceApi, keys);
  destinationBase = await serve(() => destinationOwner, () => destinationApi, keys);
});

beforeEach(() => {
  rmSync(sourceDir, { recursive: true, force: true });
  rmSync(destinationDir, { recursive: true, force: true });
  destinationOwner = DESTINATION;
  now = 1000;
  localImportConnectors([
    { id: 'conn0000001', name: 'header', url: 'https://vendor.example/mcp?key=harmless-query-fixture', config: readConfig({ auth: { kind: 'header', name: 'Authorization', value: HEADER_SECRET }, createdAt: '2026-09-01', verified: { at: '2026-09-02', server: 'fixture' }, policy: { read: 'allow', write: 'deny', tools: { fetch: 'ask' } }, toolGroups: { fetch: 'read' }, client: { clientId: 'header-client', clientSecret: 'harmless-client-fixture' } }) },
    { id: 'conn0000002', name: 'oauth', url: 'https://vendor.example/oauth', config: readConfig({ auth: { kind: 'oauth', accessToken: OAUTH_SECRET, refreshToken: 'harmless-refresh-fixture', expiresAt: 1, issuer: 'https://vendor.example', tokenEndpoint: 'https://vendor.example/token', clientId: 'oauth-client', clientSecret: 'harmless-oauth-client-fixture', scope: 'read write' }, createdAt: '2026-09-01', verified: { at: '2026-09-02', server: 'fixture' }, oauth: true, client: { clientId: 'oauth-client', clientSecret: 'harmless-oauth-client-fixture' }, policy: { write: 'ask' } }) },
  ], sourceDir);
  sourceApi = new ConnectorTransfers({ read: () => readLocalConnectors(sourceDir), copy: (value) => copyConnectorRows(value, sourceDir), now: () => now });
  destinationApi = new ConnectorTransfers({ read: () => readLocalConnectors(destinationDir), copy: (value) => copyConnectorRows(value, destinationDir), now: () => now });
});

afterAll(async () => {
  setBearerSessions(null);
  for (const server of servers) await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
  await issuer.close();
  rmSync(root, { recursive: true, force: true });
});

const request = (base: string, action: string, body: unknown, organization = base === sourceBase ? SOURCE : destinationOwner, role = 'admin'): Promise<Response> => fetch(`${base}/api/connectors/transfer/${action}`, {
  method: 'POST', headers: { authorization: `Bearer ${issuer.mint(sessionClaims({ org_id: organization, role }))}`, 'content-type': 'application/json' }, body: JSON.stringify(body), redirect: 'manual',
});

async function exportCopy(ids: string[] | null = null): Promise<{ ticket: string; envelope: Record<string, string> }> {
  const prepared = await request(destinationBase, 'prepare', { confirmed: true });
  expect(prepared.status).toBe(200);
  const target = await prepared.json() as { ticket: string; publicKey: string };
  const exported = await request(sourceBase, 'export', { confirmed: true, ids, publicKey: target.publicKey });
  expect(exported.status).toBe(200);
  expect(exported.headers.get('cache-control')).toBe('no-store');
  const text = await exported.text();
  for (const secret of [HEADER_SECRET, OAUTH_SECRET, 'harmless-query-fixture', 'harmless-refresh-fixture', 'harmless-client-fixture']) expect(text).not.toContain(secret);
  return { ticket: target.ticket, envelope: JSON.parse(text) as Record<string, string> };
}

describe('complete connector copy between separately owned daemons', () => {
  test('copies all saved credentials and settings with fresh ids, leaves the source byte-identical and rejects replay', async () => {
    const original = readFileSync(join(sourceDir, 'connectors.json'), 'utf8');
    const transfer = await exportCopy();
    const received = await request(destinationBase, 'receive', { confirmed: true, ...transfer });
    expect(received.status).toBe(200);
    const answer = await received.json() as { results: { sourceId: string; id: string; status: string }[] };
    expect(answer.results.map((row) => row.status)).toEqual(['copied', 'copied']);
    const source = readLocalConnectors(sourceDir);
    const destination = readLocalConnectors(destinationDir);
    expect(destination.map((row) => ({ ...row, id: '' }))).toEqual(source.map((row) => ({ ...row, id: '' })));
    expect(destination.map((row) => row.id)).not.toEqual(source.map((row) => row.id));
    expect(readFileSync(join(sourceDir, 'connectors.json'), 'utf8')).toBe(original);
    expect(JSON.stringify(answer)).not.toContain(HEADER_SECRET);
    expect(JSON.stringify(answer)).not.toContain(OAUTH_SECRET);
    expect((await request(destinationBase, 'receive', { confirmed: true, ...transfer })).status).toBe(410);
    expect(readLocalConnectors(destinationDir)).toHaveLength(2);
  });

  test('copies a single selected connector and skips name collisions on retry without overwriting', async () => {
    const first = await exportCopy(['conn0000001']);
    expect((await request(destinationBase, 'receive', { confirmed: true, ...first })).status).toBe(200);
    const original = readFileSync(join(destinationDir, 'connectors.json'), 'utf8');
    const retry = await exportCopy(['conn0000001']);
    const answer = await (await request(destinationBase, 'receive', { confirmed: true, ...retry })).json() as { results: { status: string }[] };
    expect(answer.results.map((row) => row.status)).toEqual(['skipped']);
    expect(readFileSync(join(destinationDir, 'connectors.json'), 'utf8')).toBe(original);
    expect(readLocalConnectors(destinationDir)).toHaveLength(1);
  });

  test('requires admin on the actual source and destination, and rejects tokens from the other organization', async () => {
    for (const [base, action] of [[sourceBase, 'export'], [destinationBase, 'prepare'], [destinationBase, 'receive']]) {
      if (base === undefined || action === undefined) throw new Error('missing test endpoint');
      const owner = base === sourceBase ? SOURCE : DESTINATION;
      expect((await request(base, action, { confirmed: true }, owner, 'member')).status).toBe(403);
      expect((await request(base, action, { confirmed: true }, owner === SOURCE ? DESTINATION : SOURCE)).status).toBe(403);
      expect((await fetch(`${base}/api/connectors/transfer/${action}`, { method: 'POST', body: '{}' })).status).toBe(401);
      expect((await request(base, action, { confirmed: true }, owner, 'unknown')).status).toBe(403);
    }
    expect(readLocalConnectors(destinationDir)).toEqual([]);
  });

  test('requires explicit confirmation on every endpoint, including export and receive', async () => {
    const transfer = await exportCopy();
    for (const [base, action] of [[sourceBase, 'export'], [destinationBase, 'prepare'], [destinationBase, 'receive']]) {
      if (base === undefined || action === undefined) throw new Error('missing test endpoint');
      expect((await request(base, action, { ...transfer, ids: null, publicKey: transfer.envelope.key })).status).toBe(400);
    }
    expect(readLocalConnectors(destinationDir)).toEqual([]);
  });

  test('rejects tampering and expired or owner-changed destination tickets before saving', async () => {
    const transfer = await exportCopy();
    const altered = { ...transfer, envelope: { ...transfer.envelope, tag: Buffer.alloc(16).toString('base64') } };
    expect((await request(destinationBase, 'receive', { confirmed: true, ...altered })).status).toBe(400);
    now += 5 * 60_000;
    expect((await request(destinationBase, 'receive', { confirmed: true, ...transfer })).status).toBe(410);
    const next = await exportCopy();
    destinationOwner = 'org_01NEWOWNER00000';
    expect((await request(destinationBase, 'receive', { confirmed: true, ...next })).status).toBe(410);
    expect(readLocalConnectors(destinationDir)).toEqual([]);
  });

  test('reports valid, conflicting and invalid rows independently without weakening permissions or exposing invalid data', async () => {
    const rows = readLocalConnectors(sourceDir);
    const existing = rows[0];
    if (existing === undefined) throw new Error('missing fixture');
    localImportConnectors([existing], destinationDir);
    const badPolicy = { id: 'conn0000003', name: 'bad', url: 'https://vendor.example/?key=do-not-leak', config: { ...existing.config, policy: { read: 'do-not-leak' } } };
    const badAuth = { ...existing, id: 'conn0000004', name: 'bad-auth', config: { ...existing.config, auth: { kind: 'oauth', accessToken: '' } } };
    const warnings = spyOn(log, 'warn');
    try {
      const results = copyConnectorRows({ version: 1, connectors: [existing, rows[1], badPolicy, badAuth] }, destinationDir);
      expect(results.map((row) => row.status)).toEqual(['skipped', 'copied', 'invalid', 'invalid']);
      expect(JSON.stringify(results)).not.toContain('do-not-leak');
      expect(JSON.stringify(warnings.mock.calls)).not.toContain('do-not-leak');
      expect(readLocalConnectors(destinationDir).map((row) => row.name)).toEqual(['header', 'oauth']);
    } finally {
      warnings.mockRestore();
    }
  });

  test('bounds pending transfer keys and frees expired tickets', async () => {
    for (let i = 0; i < 64; i += 1) expect((await request(destinationBase, 'prepare', { confirmed: true })).status).toBe(200);
    expect((await request(destinationBase, 'prepare', { confirmed: true })).status).toBe(429);
    now += 5 * 60_000;
    expect((await request(destinationBase, 'prepare', { confirmed: true })).status).toBe(200);
  });

  test('rejects a deleted selection and oversized bodies without leaking supplied keys', async () => {
    const target = await (await request(destinationBase, 'prepare', { confirmed: true })).json() as { publicKey: string };
    expect((await request(sourceBase, 'export', { confirmed: true, ids: ['missing0001'], publicKey: target.publicKey })).status).toBe(404);
    const res = await request(sourceBase, 'export', { confirmed: true, ids: null, publicKey: 'harmless-secret-invalid-key' });
    expect((await res.text())).not.toContain('harmless-secret-invalid-key');
    expect(res.ok).toBe(false);
    expect((await request(destinationBase, 'receive', { confirmed: true, padding: 'x'.repeat(5 * 1024 * 1024) })).status).toBe(413);
  });
});
