import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import type { FetchLike } from '@metro-labs/core/stations/oauth';
import { connectors, connectorAgents } from '../src/db/schema.ts';
import { orgConnectorStore } from '@metro-labs/connectors/db/connectors';
import { declaredIcons, readToolListings } from '@metro-labs/connectors/db/connector-tools';
import { sealConnectorSecret, type ConnectorSecret } from '@metro-labs/connectors/model';
import { type ConnectorView } from '../src/connectors/model.ts';
import { auth, TEST_OWNER, TEST_STRANGER } from './identity-helper.ts';
import { PGLITE_START_MS, PGLITE_STEP_MS, testDb, type TestDb } from './pglite-db.ts';
import { ACCESS, GOOD_KEY, REFRESH, startApi, startVendor, type Api, type Vendor } from './org-connectors-fixture.ts';

let held: TestDb;
let vendor: Vendor;
let api: Api;
let now = Date.parse('2026-10-12T05:00:00.000Z');
let broken = false;
let denied = 0;
let escaped = false;
let listed: Record<string, unknown>[] | null = null;
let seen: { url: string; method: string; rpc: string; authorization: string; session: string | null }[] = [];
const result = (id: unknown, value: unknown): Response => Response.json({ jsonrpc: '2.0', id, result: value }, { headers: { 'mcp-session-id': 'catalogue-session' } });

const send: FetchLike = async (url, init) => {
  const endpoint = new URL(url);
  if (endpoint.origin !== vendor.base || init?.redirect !== 'manual') throw new Error('Unapproved test network');
  if (endpoint.pathname === '/token') return vendor.fetch(url, init);
  const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as { id?: unknown; method?: string; params?: { cursor?: string } };
  const headers = new Headers(init?.headers);
  seen.push({ url, method: init?.method ?? '', rpc: body.method ?? '', authorization: headers.get('authorization') ?? '', session: headers.get('mcp-session-id') });
  if (init?.method === 'DELETE') return new Response(null, { status: 204 });
  if (denied > 0) { denied -= 1; return new Response('secret refused', { status: 401 }); }
  if (body.method === 'initialize') return result(body.id, { protocolVersion: '2025-11-25', capabilities: {}, serverInfo: { name: 'vendor', icons: [{ src: 'https://cdn.vendor.example/icon.png', mimeType: 'image/png' }, { src: `https://cdn.vendor.example/i.png?k=${GOOD_KEY}` }] } });
  if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
  if (body.method !== 'tools/list') throw new Error('Actual tool execution must never be relayed centrally');
  if (escaped) throw new Error(`${url} ${GOOD_KEY} ${REFRESH}`);
  if (broken) return result(body.id, { tools: [], nextCursor: 'loop' });
  if (listed !== null) return result(body.id, { tools: listed });
  if (body.params?.cursor === 'page2') return result(body.id, { tools: [{ name: 'destroy', description: 'Deletes a row', annotations: { destructiveHint: true } }, { name: 'unknown' }] });
  return result(body.id, { tools: [{ name: 'find', title: 'Find', annotations: { readOnlyHint: true }, description: `Use ${url} ${GOOD_KEY} ${ACCESS} ${REFRESH}`, inputSchema: { secret: GOOD_KEY } }], nextCursor: 'page2' });
};
const call = async (path: string, authorization?: string): Promise<Response> => fetch(`${api.base}/api/connectors${path}`, { headers: { authorization: authorization ?? await auth(TEST_OWNER) } });

async function add(path = '/private/path?api_key=URL_ONLY_SECRET', value = GOOD_KEY): Promise<ConnectorView> {
  const response = await fetch(`${api.base}/api/connectors`, { method: 'POST', headers: { authorization: await auth(TEST_OWNER), 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Same name', url: `${vendor.base}${path}`, value }) });
  expect(response.status).toBe(201);
  return (await response.json() as { connector: ConnectorView }).connector;
}

async function oauth(row: ConnectorView, imported = false): Promise<void> {
  const key = api.deps.key();
  if (key === null) throw new Error('fixture key missing');
  const secret: ConnectorSecret = {
    kind: 'oauth', targetUrl: `${vendor.base}/oauth`, client: { clientId: 'client-id', clientSecret: 'PRIVATE_CLIENT_SECRET' },
    server: { issuer: vendor.base, authorizationEndpoint: `${vendor.base}/authorize`, tokenEndpoint: `${vendor.base}/token`, registrationEndpoint: null, supportsS256: true, scopes: ['read'] },
    tokens: { accessToken: 'old-access-token', refreshToken: REFRESH, expiresAt: now - 1, resource: `${vendor.base}/oauth` },
    ...(imported ? { imported: { state: 'owned', tokenEndpointAuthMethod: 'client_secret_post' } } as const : {}),
  };
  await held.db.update(connectors).set({ auth: 'oauth', secret: sealConnectorSecret(key, { owner: TEST_OWNER, id: row.id }, secret) }).where(eq(connectors.id, row.id));
}

beforeAll(async () => { held = await testDb(); vendor = await startVendor(); api = await startApi(() => held.db, () => now, send); }, PGLITE_START_MS);
beforeEach(async () => { now += 60_000; await held.reset(); seen = []; broken = false; denied = 0; escaped = false; listed = null; vendor.tokenCalls = 0; }, PGLITE_STEP_MS);
afterAll(async () => { await api.close(); await vendor.close(); await held.close(); });

describe('safe organization tool discovery', () => {
  test('lists every page while fully blocked and unassigned without changing either policy', async () => {
    const row = await add();
    await held.db.update(connectors).set({ policy: '{"read":"deny","write":"deny"}' }).where(eq(connectors.id, row.id));
    seen = [];
    const response = await call(`/${row.id}/tools`, await auth(TEST_OWNER, 'member'));
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain('URL_ONLY_SECRET');
    expect(text).not.toContain('/private/path');
    expect(text).not.toContain(GOOD_KEY);
    expect(JSON.parse(text) as unknown).toMatchObject({ tools: [{ name: 'find', readOnly: true, inputSchema: { secret: '[redacted]' } }, { name: 'destroy', readOnly: false, destructive: true }, { name: 'unknown', readOnly: false }] });
    expect(seen.map((request) => request.rpc || request.method)).toEqual(['initialize', 'notifications/initialized', 'tools/list', 'tools/list', 'DELETE']);
    expect(seen.every((request) => request.authorization === GOOD_KEY)).toBe(true);
    expect(seen[2]?.session).toBe('catalogue-session');
    expect((await orgConnectorStore(() => held.db).find(TEST_OWNER, row.id))?.policy).toBe('{"read":"deny","write":"deny"}');
    expect(await held.db.select().from(connectorAgents)).toEqual([]);
    const kept = (await readToolListings(held.db, [row.id])).get(row.id);
    expect(kept?.tools?.map((tool) => tool.name)).toEqual(['find', 'destroy', 'unknown']);
    expect(kept?.icons).toEqual([{ src: 'https://cdn.vendor.example/icon.png', mimeType: 'image/png' }]);
    expect(await declaredIcons(held.db, new URL(vendor.base).origin)).toEqual(kept?.icons ?? []);
  });

  test('withholds individual endpoint segments and their encoded and decoded forms', async () => {
    for (const segment of ['p4thSecret', 'p%34thSecret', 'p4th%2FSecret', 'p4th%252FSecret']) {
      const row = await add(`/tenant/${segment}/mcp`);
      const forms = [segment, decodeURIComponent(segment), decodeURIComponent(decodeURIComponent(segment))];
      const exposed = [...new Set(forms.flatMap((form) => [form, encodeURIComponent(form), encodeURIComponent(form).replace(/%[A-F0-9]{2}/g, (escape) => escape.toLowerCase())]))];
      listed = [{ name: 'find', title: `Workspace: ${exposed.join(' ')}`, description: exposed.join(' ') }];
      const response = await call(`/${row.id}/tools`);
      expect(response.status).toBe(200);
      const text = await response.text();
      for (const variant of exposed) expect(text).not.toContain(variant);
      expect(text).toContain('[redacted]');
    }
  });

  test('recursively decoded path separators cannot reveal private segments in metadata', async () => {
    for (const path of ['/tenant%2Fp4thSecret%2Fmcp', '/tenant%2fp4thSecret%2fmcp', '/tenant%252Fp4thSecret%252Fmcp', '/tenant%252fp%2534thSecret%252fmcp']) {
      const row = await add(path);
      listed = [{ name: 'find', title: 'Workspace: p4thSecret', description: 'Workspace: p4thSecret' }];
      const response = await call(`/${row.id}/tools`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ tools: [{ name: 'find', title: 'Workspace: [redacted]', description: 'Workspace: [redacted]', readOnly: false }] });
    }
  });

  test('a tool name echoing any private path segment is refused without returning it', async () => {
    const cases = [
      ['/tenant/p4thSecret/mcp', 'find_p4thSecret'], ['/tenant/p4th%2FSecret/mcp', 'p4th/Secret'],
      ['/tenant%2Fp4thSecret%2Fmcp', 'find_p4thSecret'], ['/tenant%252Fp4thSecret%252Fmcp', 'find_p4thSecret'],
      ['/v1/private/sse', 'get_private_status'], ['/v1/x/mcp', 'find_x'], ['/v1/mcpSecret', 'get_mcpSecret_status'],
      ['/api/v1/mcp', 'find_api'], ['/api/v1/mcp', 'find_v1'],
      ['/v1/mcp/mcp', 'get_mcp_status'], ['/v1/sse/sse', 'get_sse_status'], ['/v1%252Fmcp%252Fmcp', 'get_mcp_status'],
    ];
    for (const [path, name] of cases) {
      const row = await add(path);
      listed = [{ name, annotations: { readOnlyHint: true } }];
      const response = await call(`/${row.id}/tools`);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: 'The provider could not return its tool list. Try again.' });
      expect(seen.at(-1)?.method).toBe('DELETE');
    }
  });

  test('only exact terminal mcp or sse is assumed public for names, never metadata', async () => {
    const cases = [
      ['/v1/mcp', 'mcp'], ['/mcp', 'mcp'], ['/v1/sse', 'sse'], ['/v1/%6Dcp', 'mcp'],
      ['/v1/%2573se', 'sse'], ['/v1%2Fmcp', 'mcp'], ['/v1%252Fsse', 'sse'],
    ];
    for (const [path, route] of cases) {
      const row = await add(path);
      const name = `get_${route}_status`;
      listed = [{ name, title: 'Status', description: `Route: ${route}`, annotations: { readOnlyHint: true } }];
      const response = await call(`/${row.id}/tools`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ tools: [{ name, title: 'Status', description: 'Route: [redacted]', readOnly: true }] });
    }
  });

  test('explicit header and query credentials override the terminal route assumption', async () => {
    const cases = [
      ['/v1/mcp', 'mcp'], ['/v1/mcp', 'Bearer mcp'], ['/v1/mcp', '%6dcp'],
      ['/v1/mcp?key=mcp', GOOD_KEY], ['/v1/mcp?key=%6dcp', GOOD_KEY], ['/v1/mcp?key=m%2563p', GOOD_KEY],
    ];
    for (const [path, value] of cases) {
      const row = await add(path, value);
      listed = [{ name: 'get_mcp_status' }];
      const response = await call(`/${row.id}/tools`);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: 'The provider could not return its tool list. Try again.' });
      expect(seen.at(-1)?.method).toBe('DELETE');
    }
  });

  test('explicit OAuth credentials override the terminal route assumption without refreshing', async () => {
    const key = api.deps.key();
    if (key === null) throw new Error('fixture key missing');
    for (const credential of ['clientSecret', 'accessToken', 'refreshToken']) {
      const row = await add('/v1/mcp');
      const secret: ConnectorSecret = {
        kind: 'oauth', targetUrl: `${vendor.base}/v1/mcp`, client: { clientId: 'client-id', clientSecret: credential === 'clientSecret' ? 'mcp' : 'PRIVATE_CLIENT_SECRET' },
        server: { issuer: vendor.base, authorizationEndpoint: `${vendor.base}/authorize`, tokenEndpoint: `${vendor.base}/token`, registrationEndpoint: null, supportsS256: true, scopes: ['read'] },
        tokens: { accessToken: credential === 'accessToken' ? 'mcp' : ACCESS, refreshToken: credential === 'refreshToken' ? 'mcp' : REFRESH, expiresAt: now + 3600_000, resource: `${vendor.base}/v1/mcp` },
      };
      await held.db.update(connectors).set({ auth: 'oauth', secret: sealConnectorSecret(key, { owner: TEST_OWNER, id: row.id }, secret) }).where(eq(connectors.id, row.id));
      listed = [{ name: 'get_mcp_status' }];
      const response = await call(`/${row.id}/tools`);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: 'The provider could not return its tool list. Try again.' });
      expect(seen.at(-1)?.method).toBe('DELETE');
    }
    expect(vendor.tokenCalls).toBe(0);
  });

  test('supported slash, colon and maximum-length names retain provider Read hints', async () => {
    const row = await add('/gateway');
    const names = ['files/read', 'files:read', 'x'.repeat(256)];
    listed = names.map((name) => ({ name, annotations: { readOnlyHint: true } }));
    const response = await call(`/${row.id}/tools`);
    expect(response.status).toBe(200);
    const titles = ['Files/read', 'Files:read', `X${'x'.repeat(255)}`];
    expect(await response.json()).toEqual({ tools: names.map((name, at) => ({ name, title: titles[at], description: '', readOnly: true })) });
  });

  test('no auth or another organization cannot discover or infer a connector', async () => {
    const row = await add();
    seen = [];
    expect((await fetch(`${api.base}/api/connectors/${row.id}/tools`)).status).toBe(401);
    expect((await call(`/${row.id}/tools`, await auth(TEST_STRANGER))).status).toBe(404);
    expect((await call('/missing0001/tools')).status).toBe(404);
    expect(seen).toEqual([]);
  });

  test('partial, looping, or failing discovery returns a generic error and closes its session', async () => {
    const row = await add();
    broken = true;
    const partial = await call(`/${row.id}/tools`);
    expect(partial.status).toBe(503);
    expect(await partial.text()).not.toContain('tools');
    expect(seen.at(-1)?.method).toBe('DELETE');
    broken = false;
    escaped = true;
    const failed = await call(`/${row.id}/tools`);
    expect(failed.status).toBe(503);
    const text = await failed.text();
    for (const secret of [GOOD_KEY, REFRESH, 'URL_ONLY_SECRET', '/private/path']) expect(text).not.toContain(secret);
  });

  test('native OAuth refresh stays central and single-flight even when every tool is blocked', async () => {
    const row = await add();
    await oauth(row);
    await held.db.update(connectors).set({ policy: '{"read":"deny","write":"deny"}' }).where(eq(connectors.id, row.id));
    seen = [];
    const responses = await Promise.all([call(`/${row.id}/tools`), call(`/${row.id}/tools`)]);
    for (const response of responses) {
      expect(response.status).toBe(200);
      const text = await response.text();
      for (const secret of [ACCESS, REFRESH, 'PRIVATE_CLIENT_SECRET']) expect(text).not.toContain(secret);
    }
    expect(vendor.tokenCalls).toBe(1);
    expect(seen.every((request) => request.authorization === `Bearer ${ACCESS}`)).toBe(true);
    expect(vendor.tokenForms.at(-1)?.get('resource')).toBe(`${vendor.base}/oauth`);
  });

  test('imported OAuth uses its existing central refresh owner and provider rejection refreshes at most once', async () => {
    const row = await add();
    await oauth(row, true);
    expect((await call(`/${row.id}/tools`)).status).toBe(200);
    expect(vendor.tokenCalls).toBe(1);
    denied = 10;
    const rejected = await call(`/${row.id}/tools`);
    expect(rejected.status).toBe(424);
    expect(vendor.tokenCalls).toBe(2);
    expect(await rejected.text()).not.toContain('secret refused');
  });
});
