import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { ConnectorSyncStatus } from '@metro-labs/core/connector-sync';
import { clearAccount } from '../src/auth/account.js';
import { setCurrentServer } from '../src/auth/daemon.js';
import { createConnectorSync, CONNECTOR_SYNC_UPDATE, type ConnectorSync } from '../src/api/connector-sync.js';
import { connectorSyncStatusOf, currentSyncStatus, syncReceiptLabel } from '../src/api/connector-sync-status.js';
import { beginEnrollment } from '../src/api/enrollment-scope.js';
import { configurePlatform, memoryKeyValue } from '../src/platform.js';
import { installTestAccount, TEST_ORGANIZATION } from './account-fixture.js';

const realFetch = globalThis.fetch;
const server = { id: 'central0001', host: 'agent.example' };
const MODE = 'https://agent.example/api/mode';
const SYNC = 'https://agent.example/api/connectors/sync';
const SCOPE = 's'.repeat(43);
let mode: Record<string, unknown>;
let status: ConnectorSyncStatus;
let response: unknown;
let code: number;
let requests: Array<{ url: string; init: RequestInit }>;
let flows: ConnectorSync[];

function flow(): ConnectorSync {
  const sync = createConnectorSync(server);
  flows.push(sync);
  return sync;
}

function received(): ConnectorSyncStatus {
  return { ...status, enabled: true, state: 'received', lastReceivedAt: Date.now(), leaseExpiresAt: Date.now() + 90_000, counts: { total: 3, ready: 2, unavailable: 1 } };
}

beforeEach(() => {
  configurePlatform({ kv: memoryKeyValue(), tabKv: memoryKeyValue() });
  installTestAccount();
  setCurrentServer(server);
  mode = { mode: 'local', owner: TEST_ORGANIZATION, version: '0.1.0-beta.289' };
  status = { enabled: false, source: 'default', enrolled: true, owner: TEST_ORGANIZATION, agentId: server.id, scope: SCOPE, liveEnabled: false, state: 'off', lastReceivedAt: null, leaseExpiresAt: null, counts: null };
  response = undefined;
  code = 200;
  requests = [];
  flows = [];
  globalThis.fetch = Object.assign((input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = String(input);
    requests.push({ url, init });
    if (url === MODE) return Promise.resolve(Response.json(mode));
    if (url === SYNC) return Promise.resolve(Response.json(response ?? status, { status: code }));
    throw new Error('Unexpected request');
  }, { preconnect: realFetch.preconnect });
});

afterEach(() => {
  for (const sync of flows) sync.dispose();
  globalThis.fetch = realFetch;
  clearAccount();
  setCurrentServer(null);
});

describe('organization connector sync control', () => {
  test('reads have one bounded mode preflight and never write or report an initial receipt', async () => {
    const sync = flow();
    expect(requests).toHaveLength(0);
    const result = await sync.read();
    expect(result).toEqual(status);
    expect(syncReceiptLabel(result)).toBe('Sync is off.');
    expect(requests.map(({ url, init }) => [url, init.method])).toEqual([[MODE, 'GET'], [SYNC, 'GET']]);
    for (const { init } of requests) {
      expect(init.redirect).toBe('error');
      expect(init.signal).toBeInstanceOf(AbortSignal);
    }
  });

  test('an explicit save sends only enabled and the captured scope, then returns waiting without counts', async () => {
    const sync = flow();
    await sync.read();
    status = { ...status, enabled: true, source: 'saved', state: 'waiting' };
    const result = await sync.save(true);
    expect(requests.at(-1)?.init.body).toBe(JSON.stringify({ enabled: true, scope: SCOPE }));
    expect(requests.at(-1)?.init.method).toBe('PUT');
    expect(result.counts).toBeNull();
    expect(syncReceiptLabel(result)).toContain('Waiting');
    expect(requests.filter(({ url }) => url === MODE)).toHaveLength(2);
  });

  test('saving before a successful read is refused without a request', async () => {
    await expect(flow().save(true)).rejects.toThrow('Refresh status');
    expect(requests).toHaveLength(0);
  });

  test('members and signed-out users make no request', async () => {
    installTestAccount({ role: 'member' });
    await expect(flow().read()).rejects.toThrow('Only an admin');
    clearAccount();
    await expect(flow().read()).rejects.toThrow('changed');
    expect(requests).toHaveLength(0);
  });

  test('old daemons are stopped by the single preflight before their unsupported route', async () => {
    mode.version = '0.1.0-beta.288';
    await expect(flow().read()).rejects.toThrow(CONNECTOR_SYNC_UPDATE);
    expect(requests.map(({ url }) => url)).toEqual([MODE]);
  });

  test('unknown versions try the endpoint once and 404 gives the update notice', async () => {
    mode.version = null;
    code = 404;
    response = { error: 'private upstream detail' };
    await expect(flow().read()).rejects.toThrow(CONNECTOR_SYNC_UPDATE);
    expect(requests.map(({ url }) => url)).toEqual([MODE, SYNC]);
  });

  test('401 and 403 are fixed safe errors with no authentication retry loop', async () => {
    response = { error: 'private upstream detail' };
    for (const statusCode of [401, 403]) {
      code = statusCode;
      requests = [];
      const message = await flow().read().catch((error: unknown) => error instanceof Error ? error.message : '');
      expect(message).toContain('admin');
      expect(message).not.toContain('private');
      expect(requests.map(({ url }) => url)).toEqual([MODE, SYNC]);
    }
  });

  test('scope replacement 409 never reports success and requires a fresh read before another save', async () => {
    const sync = flow();
    await sync.read();
    code = 409;
    response = { error: 'private owner or enrollment detail' };
    await expect(sync.save(true)).rejects.toThrow('may have reached the agent');
    const count = requests.length;
    await expect(sync.save(true)).rejects.toThrow('Refresh status');
    expect(requests).toHaveLength(count);
  });

  test('refuses a response naming another owner, agent or save scope', async () => {
    for (const patch of [{ owner: 'org_other' }, { agentId: 'other000001' }]) {
      response = { ...status, ...patch };
      await expect(flow().read()).rejects.toThrow('Could not read');
    }
    response = undefined;
    const sync = flow();
    await sync.read();
    response = { ...status, enabled: true, state: 'waiting', scope: 'x'.repeat(43) };
    await expect(sync.save(true)).rejects.toThrow('could not be confirmed');
  });

  test('preflight rejects another owner or a stopped daemon without calling sync', async () => {
    for (const patch of [{ owner: 'org_other' }, { stopped: true }]) {
      const original = mode;
      mode = { ...mode, ...patch };
      await expect(flow().read()).rejects.toThrow();
      mode = original;
    }
    expect(requests.every(({ url }) => url === MODE)).toBe(true);
  });

  test('account, server and enrollment changes abort requests, including switches away and back', async () => {
    const changes = [
      () => { clearAccount(); installTestAccount(); },
      () => { installTestAccount({ org_id: 'org_other' }); installTestAccount(); },
      () => { setCurrentServer({ id: 'other000001', host: 'other.example' }); setCurrentServer(server); },
      () => { setCurrentServer({ ...server, host: 'other.example' }); setCurrentServer(server); },
      () => { const finish = beginEnrollment(); finish(); },
    ];
    const serve = globalThis.fetch;
    for (const change of changes) {
      requests = [];
      globalThis.fetch = Object.assign((input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const result = serve(input, init);
        if (String(input) === SYNC) change();
        return result;
      }, { preconnect: realFetch.preconnect });
      await expect(flow().read()).rejects.toThrow('changed');
      expect(requests.at(-1)?.init.signal?.aborted).toBe(true);
    }
  });

  test('a switch during preflight cannot send a status read or write to the new daemon', async () => {
    const serve = globalThis.fetch;
    globalThis.fetch = Object.assign((input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const result = serve(input, init);
      setCurrentServer({ ...server, host: 'other.example' });
      return result;
    }, { preconnect: realFetch.preconnect });
    await expect(flow().read()).rejects.toThrow('changed');
    expect(requests.map(({ url }) => url)).toEqual([MODE]);
  });

  test('live environment or missing enrollment blocks ON but still permits saving OFF', async () => {
    for (const patch of [{ liveEnabled: true }, { enrolled: false, agentId: null }]) {
      status = { ...status, ...patch };
      const sync = flow();
      await sync.read();
      const count = requests.length;
      await expect(sync.save(true)).rejects.toThrow();
      expect(requests).toHaveLength(count);
      await sync.read();
      status = { ...status, source: 'saved' };
      expect((await sync.save(false)).enabled).toBe(false);
    }
  });

  test('projection omits extra fields and shows counts only for a verified current receipt', async () => {
    const receipt = received();
    response = { ...receipt, secret: 'private', counts: { ...receipt.counts, secret: 'private' } };
    const result = await flow().read();
    expect(result).toEqual(receipt);
    expect(syncReceiptLabel(result)).toBe('Received 3 connectors: 2 ready, 1 unavailable.');
    expect(currentSyncStatus(result, receipt.leaseExpiresAt ?? 0)).toEqual({ ...receipt, state: 'expired', counts: null });
    expect(syncReceiptLabel({ ...receipt, leaseExpiresAt: Date.now() - 1 })).toContain('expired');
  });

  test('an empty verified snapshot is explicit, and waiting, unavailable or expired never invents counts', () => {
    const receipt = { ...received(), counts: { total: 0, ready: 0, unavailable: 0 } };
    expect(syncReceiptLabel(receipt)).toBe('Received an empty snapshot. No organization connectors were delivered.');
    for (const state of ['waiting', 'unavailable', 'expired'] as const) {
      const result = connectorSyncStatusOf({ ...receipt, state, counts: null }, TEST_ORGANIZATION, server.id);
      expect(result.counts).toBeNull();
      expect(syncReceiptLabel(result)).not.toContain('0 connectors');
    }
    for (const patch of [{ counts: { total: 3, ready: 3, unavailable: 3 } }, { lastReceivedAt: null }, { enabled: false }, { enrolled: false, agentId: null }]) expect(() => connectorSyncStatusOf({ ...receipt, ...patch }, TEST_ORGANIZATION, server.id)).toThrow();
  });

  test('dispose and duplicate actions cannot keep running or send another request', async () => {
    const sync = flow();
    const first = sync.read();
    await expect(sync.read()).rejects.toThrow('already being');
    await first;
    sync.dispose();
    await expect(sync.read()).rejects.toThrow('changed');
    expect(requests).toHaveLength(2);
  });
});
