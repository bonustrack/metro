import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { agentSignatureValid, readAgentProof } from '@metro-labs/http/agent-signature';
import { sealConnectorDelivery, type DeliveryContext, type DeliverySnapshot } from '@metro-labs/http/connector-delivery';
import { newAgentKey, readAgentKey, saveAgentKey, type AgentKey } from '../src/connectors/agent-key.ts';
import { OrgConnectorSync } from '../src/connectors/org-sync.ts';
import { stopOrgConnectorSync, watchOrgConnectorSync } from '../src/connectors/org-sync-watch.ts';

const OWNER = 'org_01AGENTOWNER00000';
const AGENT = 'agent000001';
const BASE = 'https://api.metro.test';
const REVISION = Buffer.alloc(32, 17).toString('base64url');
let dir = '';
let owner: string | null = OWNER;
let enabled = true;
let now = 1_800_000_000_000;
let monotonic = 1000;
let key: AgentKey;
let rows: DeliverySnapshot['connectors'];
let sync: OrgConnectorSync;
let calls: { url: string; body: Record<string, unknown> }[] = [];
let respond: ((context: DeliveryContext, snapshot: DeliverySnapshot) => Promise<Response>) | null = null;

const snapshot = (): DeliverySnapshot => ({ version: 1, issuedAt: now, expiresAt: now + 90_000, connectors: rows });
const files = (): Record<string, string> => Object.fromEntries(readdirSync(dir).map((name) => [name, readFileSync(join(dir, name), 'utf8')]));

async function fetchApi(url: string, init: RequestInit): Promise<Response> {
  const text = typeof init.body === 'string' ? init.body : '';
  const body = JSON.parse(text) as Record<string, unknown>;
  calls.push({ url, body });
  const proof = readAgentProof(new Headers(init.headers).get('authorization') ?? undefined);
  expect(proof).not.toBeNull();
  if (proof === null) throw new Error('missing proof');
  expect(agentSignatureValid({ method: init.method ?? '', host: new URL(url).host, path: new URL(url).pathname, body: Buffer.from(text) }, proof, key.signingKey)).toBe(true);
  expect(body.requestId).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(init.redirect).toBe('error');
  const context = { owner: OWNER, agent: AGENT, keyId: key.keyId, requestId: String(body.requestId) };
  const value = snapshot();
  return respond === null ? Response.json({ sealed: sealConnectorDelivery(key.sealingKey, context, value) }) : respond(context, value);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'metro-org-sync-'));
  owner = OWNER;
  enabled = true;
  now = 1_800_000_000_000;
  monotonic = 1000;
  key = { ...newAgentKey(), enrollment: { organization: OWNER, server: AGENT, at: new Date(now).toISOString() } };
  saveAgentKey(key, { organization: OWNER, server: AGENT, at: new Date(now).toISOString() }, dir);
  writeFileSync(join(dir, 'connectors.json'), JSON.stringify({ connectors: [{ id: 'local000001', name: 'Local', config: { value: 'local-secret' } }] }));
  rows = [{ id: 'conn0000001', name: 'Organization MCP', url: 'https://mcp.example/path?private=org-url-secret', auth: 'oauth', headers: { Authorization: 'Bearer org-access-secret' }, policy: { write: 'deny' }, revision: REVISION, state: 'ready', expiresAt: now + 120_000 }];
  calls = [];
  respond = null;
  sync = new OrgConnectorSync({ owner: () => owner, key: () => readAgentKey(dir), enabled: () => enabled, api: { base: BASE, now: () => now, fetch: fetchApi }, monotonic: () => monotonic });
});

afterEach(() => {
  sync.invalidate();
  stopOrgConnectorSync();
  rmSync(dir, { recursive: true, force: true });
});

test('signed delivery lives only in memory and never changes local configuration or key files', async () => {
  const before = files();
  await sync.sync();
  expect(calls[0]?.url).toBe(`${BASE}/api/agents/connectors`);
  expect(Object.keys(calls[0]?.body ?? {})).toEqual(['requestId']);
  expect(sync.read()?.connectors).toEqual(rows);
  expect(files()).toEqual(before);
  expect(JSON.stringify(files())).not.toContain('org-access-secret');
  expect(JSON.stringify(files())).not.toContain('org-url-secret');
  const read = sync.read()?.connectors[0];
  if (read !== undefined) read.headers.Authorization = 'changed';
  expect(sync.read()?.connectors[0]?.headers.Authorization).toBe('Bearer org-access-secret');
});

test('missing enrollment, wrong organization and disabled sync make no API request', async () => {
  enabled = false;
  await sync.sync();
  enabled = true;
  owner = 'org_01SOMEONEELSE00';
  await sync.sync();
  owner = null;
  await sync.sync();
  owner = OWNER;
  rmSync(join(dir, 'agent-key.json'));
  await sync.sync();
  expect(calls).toEqual([]);
  expect(sync.read()).toBeNull();
});

test('assignment removal and stricter policies replace the complete snapshot atomically', async () => {
  await sync.sync();
  rows = rows.map((row) => ({ ...row, policy: { read: 'deny', write: 'deny' } }));
  await sync.sync();
  expect(sync.read()?.connectors[0]?.policy).toEqual({ read: 'deny', write: 'deny' });
  rows = [];
  await sync.sync();
  expect(sync.read()?.connectors).toEqual([]);
});

test('revocation and an API outage clear memory without touching local connectors', async () => {
  const before = files();
  await sync.sync();
  respond = async () => Response.json({ error: 'key revoked' }, { status: 401 });
  await expect(sync.sync()).rejects.toThrow('key revoked');
  expect(sync.read()).toBeNull();
  respond = null;
  await sync.sync();
  respond = async () => { throw new Error('network down'); };
  await expect(sync.sync()).rejects.toThrow('could not reach');
  expect(sync.read()).toBeNull();
  expect(files()).toEqual(before);
});

test('lease and credential expiry fail closed even when wall time moves backwards', async () => {
  await sync.sync();
  now -= 300_000;
  monotonic += 90_000;
  expect(sync.read()).toBeNull();
  now += 300_000;
  rows = rows.map((row) => ({ ...row, expiresAt: now + 5000 }));
  await sync.sync();
  now += 5001;
  expect(sync.read()).toBeNull();
});

test('credential lifetime uses API time even when the daemon clock is ahead or behind', async () => {
  for (const offset of [120_000, -120_000]) {
    respond = async (context, value) => {
      const issuedAt = now + offset;
      return Response.json({ sealed: sealConnectorDelivery(key.sealingKey, context, { ...value, issuedAt, expiresAt: issuedAt + 90_000, connectors: rows.map((row) => ({ ...row, expiresAt: issuedAt + 30_000 })) }) });
    };
    await sync.sync();
    expect(sync.read()?.connectors[0]?.state).toBe('ready');
    now += 31_000;
    monotonic += 31_000;
    expect(sync.read()).toBeNull();
  }
});

test('a slow response cannot extend a delivery lease', async () => {
  respond = async (context, value) => {
    monotonic += 90_001;
    return Response.json({ sealed: sealConnectorDelivery(key.sealingKey, context, value) });
  };
  await expect(sync.sync()).rejects.toThrow('expired');
  expect(sync.read()).toBeNull();
});

test('an owner change while a request waits cannot install its old credentials', async () => {
  const reached = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  respond = async (context, value) => {
    reached.resolve();
    await release.promise;
    return Response.json({ sealed: sealConnectorDelivery(key.sealingKey, context, value) });
  };
  const running = sync.sync();
  await reached.promise;
  owner = 'org_01SOMEONEELSE00';
  sync.invalidate();
  owner = OWNER;
  release.resolve();
  await expect(running).rejects.toThrow('invalid or expired');
  expect(sync.read()).toBeNull();
});

test('changing the key or owner immediately invalidates an installed snapshot', async () => {
  await sync.sync();
  owner = 'org_01SOMEONEELSE00';
  expect(sync.read()).toBeNull();
  owner = OWNER;
  await sync.sync();
  saveAgentKey(newAgentKey(), { organization: OWNER, server: AGENT, at: new Date(now).toISOString() }, dir);
  expect(sync.read()).toBeNull();
});

test('another request, agent or organization cannot reuse an encrypted response', async () => {
  respond = async (context, value) => Response.json({ sealed: sealConnectorDelivery(key.sealingKey, { ...context, requestId: Buffer.alloc(32, 23).toString('base64url') }, value) });
  await expect(sync.sync()).rejects.toThrow();
  expect(sync.read()).toBeNull();
  respond = async (context, value) => Response.json({ sealed: sealConnectorDelivery(key.sealingKey, { ...context, owner: 'org_01SOMEONEELSE00' }, value) });
  await expect(sync.sync()).rejects.toThrow();
  expect(sync.read()).toBeNull();
});

test('oversized answers cannot populate memory', async () => {
  respond = async () => Response.json({ padding: 'x'.repeat(1024 * 1024) });
  await expect(sync.sync()).rejects.toThrow('too large');
  expect(sync.read()).toBeNull();
});

test('overlapping polls share one request and force refresh carries only an opaque revision', async () => {
  const first = sync.sync();
  const second = sync.sync();
  await Promise.all([first, second]);
  expect(calls).toHaveLength(1);
  const refresh = { connectorId: 'conn0000001', revision: REVISION };
  await sync.sync(refresh);
  expect(calls[1]?.body.refresh).toEqual(refresh);
  expect(JSON.stringify(calls)).not.toContain('org-access-secret');
});

test('boot leaves organization sync off by default', () => {
  const previous = process.env.METRO_CONNECTORS_SYNC_ENABLED;
  delete process.env.METRO_CONNECTORS_SYNC_ENABLED;
  let reads = 0;
  try {
    watchOrgConnectorSync({ owner: () => { reads += 1; return OWNER; }, key: () => key, api: { base: BASE, now: () => now, fetch: fetchApi } });
    expect(reads).toBe(0);
    expect(calls).toEqual([]);
  } finally {
    if (previous === undefined) delete process.env.METRO_CONNECTORS_SYNC_ENABLED;
    else process.env.METRO_CONNECTORS_SYNC_ENABLED = previous;
  }
});
