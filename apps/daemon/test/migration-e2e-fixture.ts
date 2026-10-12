import { expect, spyOn } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setBearerSessions } from '@metro-labs/http/api-http';
import type { ConnectorSyncStatus } from '@metro-labs/core/connector-sync';
import { enrollDeliveryAgent, MASTER, newDeliveryAgent, startDeliveryApi } from '../../api/test/connector-delivery-fixture.js';
import { startMigrationApi } from '../../api/test/connector-migration-fixture.js';
import { postgresFixture, TEST_DATABASE_URL } from '../../api/test/connector-postgres-fixture.js';
import { auth, testKeys, TEST_OWNER, TEST_STRANGER } from '../../api/test/identity-helper.js';
import { ACCESS, challengeOf, GOOD_KEY, REFRESH, RETURN_TO, startApi } from '../../api/test/org-connectors-fixture.js';
import { connectors } from '../../api/src/db/schema.js';
import { openConnectorSecret } from '../../api/src/connectors/model.js';
import { localOwner } from '../src/agents/file-admin.js';
import { setKeyMap } from '../src/agents/keys.js';
import { readAgentKey, saveAgentKey, type AgentKey } from '../src/connectors/agent-key.js';
import type { MigrationAction, MigrationStatus, MigrationView } from '../src/connectors/migration-control.js';
import { publishLocalConnectors, publishOrgConnectors } from '../src/connectors/publication.js';
import { watchOrgConnectorSync, stopOrgConnectorSync } from '../src/connectors/org-sync-watch.js';
import { readLocalConnectors, type LocalConnectorRow } from '../src/connectors/store.js';
import { bearerSessionsFor } from '../src/routes/bearer.js';
import { localSessionApis } from '../src/routes/local-mode.js';
import { bootDaemon } from './http-harness.js';
import { LOCAL_ACCESS, LOCAL_REFRESH, MANUAL_SECRET, migrationVendor, POLICY, TOOL_GROUPS, transportFetch, URL_SECRET, VENDOR } from './migration-e2e-vendor.js';

export { TEST_DATABASE_URL, TEST_OWNER, TEST_STRANGER, GOOD_KEY, ACCESS, REFRESH };
export const SOURCE = 'local000001';
export const UNMIGRATED = 'local000002';
export const LOCAL_KEY = 'migration-agent-bearer-fixture';
export const MIGRATIONS = '/api/connectors/migrations';
const ENV = ['HOME', 'METRO_STATE_DIR', 'METRO_AGENTS_DIR', 'METRO_CLAUDE_DIR', 'METRO_RUNTIME_STORE', 'METRO_TRAINS_DIR', 'METRO_CONNECTORS_SYNC_ENABLED', 'METRO_CONNECTORS_LIVE_ENABLED', 'METRO_WEBHOOK_PORT', 'METRO_HTTP_HOST'] as const;
export type Variant = 'none' | 'query' | 'header' | 'oauth-manual' | 'oauth-dynamic';

export function sourceRow(variant: Variant): LocalConnectorRow {
  const oauth = variant.startsWith('oauth');
  const path = oauth ? '/mcp' : variant === 'header' ? '/keyed' : variant === 'query' ? '/query-keyed' : '/open';
  return {
    id: SOURCE, name: 'Migration fixture', url: `${VENDOR}${path}${oauth ? '' : `?api_key=${URL_SECRET}`}`,
    config: {
      createdAt: '', verified: { at: '', server: 'Fixture' }, oauth,
      client: variant === 'oauth-manual' ? { clientId: 'fixture-manual-client', clientSecret: MANUAL_SECRET } : null,
      auth: oauth ? { kind: 'oauth', accessToken: LOCAL_ACCESS, refreshToken: LOCAL_REFRESH, clientId: 'old-local-registration', tokenEndpoint: `${VENDOR}/token`, issuer: VENDOR, expiresAt: Date.now() + 3_600_000 } : variant === 'header' ? { kind: 'header', name: 'Authorization', value: GOOD_KEY } : { kind: 'none' },
      policy: structuredClone(POLICY), toolGroups: { ...TOOL_GROUPS },
    },
  };
}

function isolate() {
  const environment = new Map(ENV.map((name) => [name, process.env[name]]));
  const root = mkdtempSync(join(tmpdir(), 'metro-migration-e2e-'));
  for (const key of ENV.slice(0, 6)) {
    const dir = join(root, key.toLowerCase()); mkdirSync(dir, { recursive: true }); process.env[key] = dir;
  }
  delete process.env.METRO_CONNECTORS_SYNC_ENABLED;
  process.env.METRO_CONNECTORS_LIVE_ENABLED = 'false';
  return { root, restore: () => {
    for (const [key, value] of environment) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(root, { recursive: true, force: true });
  } };
}

async function listening<T>(start: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try { return await start(); }
    catch (error) {
      if (typeof error !== 'object' || error === null || !('code' in error) || error.code !== 'EADDRINUSE') throw error;
    }
  }
  throw new Error('No test port available after ten attempts');
}

export async function migrationE2E(variant: Variant = 'header', configure?: (source: LocalConnectorRow) => void) {
  if (TEST_DATABASE_URL === undefined) throw new Error('TEST_DATABASE_URL is required');
  const sandbox = isolate();
  const releases: (() => void | Promise<void>)[] = [sandbox.restore];
  try {
    const dir = process.env.METRO_AGENTS_DIR ?? '';
    const held = await postgresFixture(TEST_DATABASE_URL);
    releases.push(held.close);
    const agent = newDeliveryAgent();
    await enrollDeliveryAgent(held.db1, agent);
    const key: AgentKey = { ...agent.row, signing: agent.signing, sealing: agent.sealing, enrollment: { organization: TEST_OWNER, server: agent.row.agent, at: agent.row.enrolledAt } };
    saveAgentKey(key, key.enrollment ?? { organization: '', server: '', at: '' }, dir);
    writeFileSync(join(dir, '.owner'), TEST_OWNER);
    writeFileSync(join(dir, 'agent.json'), JSON.stringify({ version: 1, id: 'localagent1', key: LOCAL_KEY, stations: [] }));
    const source = sourceRow(variant);
    configure?.(source);
    writeFileSync(join(dir, 'connectors.json'), JSON.stringify({ version: 1, connectors: [source, { ...sourceRow('none'), id: UNMIGRATED, name: 'Unmigrated fixture' }] }));
    const plugin = join(process.env.METRO_RUNTIME_STORE ?? '', 'marketplace', 'plugin');
    mkdirSync(join(plugin, 'bin'), { recursive: true });
    writeFileSync(join(plugin, 'bin', 'metro-plugin.mjs'), '');
    const vendor = await listening(migrationVendor); releases.push(vendor.close);
    const api = await listening(() => startMigrationApi(held.db1, { fetch: vendor.fetch })); releases.push(api.close);
    const delivery = await listening(() => startDeliveryApi(held.db2, { fetch: vendor.fetch })); releases.push(delivery.close);
    const management = await listening(() => startApi(() => held.db2, Date.now, vendor.fetch)); releases.push(management.close);
    management.setKey(MASTER); management.deps.fetch = vendor.fetch; management.deps.httpsOnly = true;
    const keys = await testKeys();
    const admin = await auth(TEST_OWNER);
    const member = await auth(TEST_OWNER, 'member');
    const stranger = await auth(TEST_STRANGER);
    await keys.keyFor('key-1'); await management.deps.keys.keyFor('key-1');
    setBearerSessions(bearerSessionsFor(() => localOwner(dir), keys));
    setKeyMap([{ key: LOCAL_KEY, agentId: 'localagent1' }]);
    releases.push(() => { setBearerSessions(null); setKeyMap([]); });
    const apis = () => localSessionApis({ syncStations: () => Promise.resolve(), reloadAgents: () => Promise.resolve(), restart: () => {}, stop: () => {}, gatherAccounts: () => Promise.resolve({ accounts: {}, unavailable: [] }), capabilities: () => ({}), prepareAccount: () => Promise.reject(new Error('unused')) });
    let daemon = await listening(() => bootDaemon(apis()));
    releases.push(async () => { daemon.server.closeAllConnections(); await daemon.close(); });
    const traffic: { path: string; body: string; authorization: string; response: string }[] = [];
    const faults = { drop: '', offline: false, badDelivery: false };
    const allowed = [api.base, delivery.base, management.base, vendor.base];
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.startsWith(`${VENDOR}/`)) return vendor.fetch(url, init);
      if (!url.startsWith('https://api.metro.box/')) {
        if (url.startsWith(`${daemon.base}/`) || allowed.some((base) => url.startsWith(`${base}/`))) return transportFetch(input, init);
        throw new Error(`Unconfigured fixture transport: ${url}`);
      }
      if (faults.offline) throw new Error('fixture network unavailable');
      const path = new URL(url).pathname;
      const endpoint = path === '/api/agents/connector-migrations' ? api : delivery;
      const response = await transportFetch(`${endpoint.base}${path}`, init);
      const body = String(init?.body ?? '');
      const text = await response.text();
      traffic.push({ path, body, authorization: new Headers(init?.headers).get('authorization') ?? '', response: text });
      const action = (JSON.parse(body) as { action?: string }).action;
      if (faults.drop !== '' && faults.drop === action) { faults.drop = ''; throw new Error('fixture response lost after PostgreSQL commit'); }
      if (faults.badDelivery && path === '/api/agents/connectors') return Response.json({ sealed: 'invalid-fixture-envelope' });
      return new Response(text, { status: response.status, headers: response.headers });
    });
    releases.push(() => { fetchSpy.mockRestore(); });
    releases.push(() => { stopOrgConnectorSync(); publishOrgConnectors([]); publishLocalConnectors([]); });
    watchOrgConnectorSync({ owner: () => localOwner(dir), key: () => readAgentKey(dir), dir });
    publishLocalConnectors(readLocalConnectors(dir));
    const request = (path: string, method = 'GET', body?: unknown, authorization = admin, signal?: AbortSignal) => fetch(`${daemon.base}${path}`, { method, signal, headers: { authorization, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const status = async (): Promise<MigrationStatus> => {
      const response = await request(MIGRATIONS); expect(response.status).toBe(200); return response.json() as Promise<MigrationStatus>;
    };
    const action = async (name: MigrationAction, scope?: string) => {
      const current = await status(); const record = current.migrations.find((row) => row.sourceId === SOURCE);
      return request(MIGRATIONS, 'POST', { sourceId: SOURCE, action: name, scope: scope ?? current.scope, operationId: record?.id ?? null, ...(name === 'resolve' ? { uncertainty: record?.uncertainty ?? null } : {}) });
    };
    const move = async (name: MigrationAction): Promise<MigrationView> => {
      const response = await action(name); const text = await response.text();
      expect({ status: response.status, error: response.ok ? null : text }).toEqual({ status: 200, error: null });
      const record = (JSON.parse(text) as MigrationStatus).migrations.find((row) => row.sourceId === SOURCE);
      if (record === undefined) throw new Error('missing migration record'); return record;
    };
    const setSync = async (enabled: boolean) => {
      const current = await (await request('/api/connectors/sync')).json() as ConnectorSyncStatus;
      const response = await request('/api/connectors/sync', 'PUT', { enabled, scope: current.scope }); expect(response.status).toBe(200);
      return response.json() as Promise<ConnectorSyncStatus>;
    };
    const tool = async (name = 'read_item', id = SOURCE, signal?: AbortSignal) => {
      const response = await request(`/relay/${id}`, 'POST', { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name, arguments: {} } }, `Bearer ${LOCAL_KEY}`, signal);
      if ((name === 'hold' || name === 'hold_write') && response.ok) return response;
      return new Response(await response.arrayBuffer(), { status: response.status, headers: response.headers });
    };
    const manage = (path: string, method = 'GET', body?: unknown) => fetch(`${management.base}/api/connectors${path}`, { method, headers: { authorization: admin, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const destination = async (id: string) => {
      const row = (await held.db2.select().from(connectors)).find((value) => value.id === id);
      if (row === undefined) throw new Error('missing PostgreSQL destination');
      return { row, secret: openConnectorSecret(MASTER, row) };
    };
    const completeOAuth = async (id: string) => {
      const started = await manage(`/${id}/sign-in`, 'POST', { returnTo: RETURN_TO }); expect(started.status).toBe(200);
      const { authorizeUrl } = await started.json() as { authorizeUrl: string };
      const { state, challenge } = challengeOf(authorizeUrl); vendor.oauth.challenges.set('fresh-central-code', challenge);
      const callback = await fetch(`${management.base}/api/connectors/callback?state=${state}&code=fresh-central-code`, { redirect: 'manual' }); expect(callback.status).toBe(302);
      const handoff = new URLSearchParams(new URL(callback.headers.get('location') ?? '').hash.split('?')[1]).get('org_connector');
      const completed = await manage('/complete', 'POST', { handoff }); expect(completed.status).toBe(200);
      const text = await completed.text(); expect(text).not.toContain(ACCESS); expect(text).not.toContain(REFRESH);
    };
    return {
      dir, held, agent, key, source, vendor, api, delivery, management, traffic, faults, admin, member, stranger,
      get daemon() { return daemon; },
      request, status, action, move, setSync, tool, manage, destination, completeOAuth,
      restart: async (disconnect = false) => {
        if (disconnect) daemon.server.closeAllConnections();
        stopOrgConnectorSync(); await daemon.close(); daemon = await listening(() => bootDaemon(apis()));
        watchOrgConnectorSync({ owner: () => localOwner(dir), key: () => readAgentKey(dir), dir });
        publishLocalConnectors(readLocalConnectors(dir));
      },
      plugins: () => JSON.parse(readFileSync(join(plugin, '.mcp.json'), 'utf8')) as Record<string, { url: string }>,
      close: async () => {
        vendor.release(); stopOrgConnectorSync(); publishOrgConnectors([]); publishLocalConnectors([]);
        daemon.server.closeAllConnections();
        await daemon.close(); await api.close(); await delivery.close(); await management.close(); await vendor.close();
        fetchSpy.mockRestore(); setBearerSessions(null); setKeyMap([]); await held.close(); sandbox.restore();
      },
    };
  } catch (error) {
    const errors: unknown[] = [error];
    for (const release of releases.reverse()) { try { await release(); } catch (cleanup) { errors.push(cleanup); } }
    if (errors.length > 1) throw new AggregateError(errors, 'Migration fixture setup and cleanup failed');
    throw error;
  }
}

export type MigrationE2E = Awaited<ReturnType<typeof migrationE2E>>;
export const destinationId = (record: MigrationView): string => {
  if (record.destinationId === null) throw new Error('missing destination identity'); return record.destinationId;
};
