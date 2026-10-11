import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { log } from '@metro-labs/core/log';
import { ApiError } from '@metro-labs/http/api-error';
import { sealConnectorDelivery, type DeliverySnapshot } from '@metro-labs/http/connector-delivery';
import { newAgentKey, type AgentKey } from '../src/connectors/agent-key.ts';
import { OrgConnectorSync } from '../src/connectors/org-sync.ts';

const OWNER = 'org_01AGENTOWNER00000';
const AGENT = 'agent000001';
const REVISION = Buffer.alloc(32, 17).toString('base64url');
const SECRET = 'secret-access-token';
let key: AgentKey | null;
let owner: string | null;
let enabled: boolean;
let keyError: boolean;
let now: number;
let clock: number;
let duration: number;
let status: number;
let hold: Promise<void> | null;
let rows: DeliverySnapshot['connectors'];
let requests: Record<string, unknown>[];
let sync: OrgConnectorSync;

beforeEach(() => {
  now = 1_800_000_000_000;
  clock = 1000;
  duration = 90_000;
  owner = OWNER;
  enabled = true;
  keyError = false;
  key = { ...newAgentKey(), enrollment: { organization: OWNER, server: AGENT, at: new Date(now).toISOString() } };
  rows = [{ id: 'conn0000001', name: 'MCP', url: `https://mcp.example/?key=${SECRET}`, auth: 'oauth', headers: { Authorization: `Bearer ${SECRET}` }, policy: {}, revision: REVISION, state: 'ready' }];
  requests = [];
  hold = null;
  status = 200;
  sync = new OrgConnectorSync({
    enabled: () => enabled,
    owner: () => owner,
    key: () => {
      if (keyError) throw new Error(SECRET);
      return key;
    },
    monotonic: () => clock,
    api: {
      base: 'https://api.metro.test', now: () => now,
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        requests.push(body);
        if (key === null) throw new Error('no key');
        expect(new Headers(init.headers).get('authorization')).toStartWith('MetroAgent ');
        const sealed = sealConnectorDelivery(key.sealingKey, { owner: OWNER, agent: AGENT, keyId: key.keyId, requestId: String(body.requestId) }, { version: 1, issuedAt: now, expiresAt: now + duration, connectors: rows });
        const response = status === 200 ? Response.json({ sealed }) : Response.json({ error: 'not available' }, { status });
        if (hold !== null) await hold;
        return response;
      },
    },
  });
});

afterEach(() => { sync.invalidate(); });

test('installs notify synchronously with no transient clear, no arguments and no new epoch', async () => {
  const seen: (DeliverySnapshot | null)[] = [];
  const epochs: number[] = [];
  const args: unknown[][] = [];
  const stop = sync.onChange((...values: unknown[]) => { seen.push(sync.read()); epochs.push(sync.epoch()); args.push(values); });
  const epoch = sync.epoch();
  await sync.sync();
  rows = [];
  await sync.sync();
  expect(seen.map((value) => value?.connectors.length)).toEqual([1, 0]);
  expect(epochs).toEqual([epoch, epoch]);
  expect(args).toEqual([[], []]);
  sync.invalidate();
  expect(seen).toHaveLength(3);
  expect(seen[2]).toBeNull();
  expect(sync.epoch()).toBe(epoch + 1);
  expect(sync.read()).toBeNull();
  expect(seen).toHaveLength(3);
  stop();
  await sync.sync();
  expect(seen).toHaveLength(3);
});

for (const reason of ['owner', 'key', 'off', 'unowned', 'key-error']) {
  test(`lazy ${reason} failure clears once and a listener can safely read the cleared state`, async () => {
    const seen: (DeliverySnapshot | null)[] = [];
    sync.onChange(() => { seen.push(sync.read()); });
    await sync.sync();
    const epoch = sync.epoch();
    if (reason === 'owner') owner = 'org_01SOMEONEELSE00';
    if (reason === 'key') key = { ...newAgentKey(), enrollment: key?.enrollment ?? null };
    if (reason === 'off') enabled = false;
    if (reason === 'unowned') owner = null;
    if (reason === 'key-error') keyError = true;
    expect(sync.read()).toBeNull();
    expect(seen).toHaveLength(2);
    expect(seen[1]).toBeNull();
    expect(sync.epoch()).toBe(epoch + 1);
    expect(sync.read()).toBeNull();
    expect(seen).toHaveLength(2);
    expect(sync.epoch()).toBe(epoch + 1);
  });
}

test('sync identity exceptions clear old memory before rejecting and do not log sensitive details', async () => {
  await sync.sync();
  const epoch = sync.epoch();
  const seen: (DeliverySnapshot | null)[] = [];
  sync.onChange(() => { seen.push(sync.read()); });
  keyError = true;
  await expect(sync.sync()).rejects.toThrow(SECRET);
  expect(seen).toEqual([null]);
  expect(sync.epoch()).toBe(epoch + 1);
  expect(sync.read()).toBeNull();
});

test('API failures notify and advance the epoch without leaking credentials in callbacks', async () => {
  await sync.sync();
  const epoch = sync.epoch();
  const seen: (DeliverySnapshot | null)[] = [];
  sync.onChange(() => { seen.push(sync.read()); });
  status = 503;
  await expect(sync.sync()).rejects.toBeInstanceOf(ApiError);
  expect(seen).toEqual([null]);
  expect(sync.epoch()).toBe(epoch + 1);
});

test('a manual invalidation rejects an older response without installing or notifying again', async () => {
  const seen: (DeliverySnapshot | null)[] = [];
  sync.onChange(() => { seen.push(sync.read()); });
  const release = Promise.withResolvers<void>();
  hold = release.promise;
  const pending = sync.sync();
  sync.invalidate();
  const epoch = sync.epoch();
  expect(seen).toEqual([null]);
  release.resolve();
  await expect(pending).rejects.toBeInstanceOf(ApiError);
  expect(sync.read()).toBeNull();
  expect(seen).toEqual([null]);
  expect(sync.epoch()).toBe(epoch);
});

test('an owner change observed while the first fetch waits invalidates even with no installed snapshot', async () => {
  const release = Promise.withResolvers<void>();
  hold = release.promise;
  const pending = sync.sync();
  const epoch = sync.epoch();
  owner = null;
  expect(sync.read()).toBeNull();
  expect(sync.epoch()).toBe(epoch + 1);
  owner = OWNER;
  release.resolve();
  await expect(pending).rejects.toBeInstanceOf(ApiError);
  expect(sync.read()).toBeNull();
});

for (const source of ['timer', 'monotonic', 'wall', 'completion']) {
  test(`${source} expiry notifies and prevents a waiting old poll from reviving memory`, async () => {
    if (source === 'timer') duration = 30;
    const cleared = Promise.withResolvers<void>();
    const seen: (DeliverySnapshot | null)[] = [];
    sync.onChange(() => {
      const value = sync.read();
      seen.push(value);
      if (value === null) cleared.resolve();
    });
    await sync.sync();
    const epoch = sync.epoch();
    const release = Promise.withResolvers<void>();
    hold = release.promise;
    const pending = sync.sync();
    if (source === 'monotonic' || source === 'completion') { clock += 90_000; now -= 300_000; }
    if (source === 'wall') now += 90_000;
    if (source !== 'completion') {
      if (source !== 'timer') expect(sync.read()).toBeNull();
      await cleared.promise;
      expect(sync.epoch()).toBe(epoch + 1);
    }
    release.resolve();
    await expect(pending).rejects.toBeInstanceOf(ApiError);
    expect(sync.read()).toBeNull();
    expect(sync.epoch()).toBe(epoch + 1);
    expect(seen.map((value) => value?.connectors.length ?? null)).toEqual([1, null]);
  });
}

test('syncFresh waits an older poll, starts a new signed check, and concurrent dispatches share that newer check', async () => {
  const release = Promise.withResolvers<void>();
  hold = release.promise;
  const old = sync.sync();
  const first = sync.syncFresh();
  const second = sync.syncFresh();
  expect(requests).toHaveLength(1);
  rows = [];
  hold = null;
  release.resolve();
  await Promise.all([old, first, second]);
  expect(requests).toHaveLength(2);
  expect(requests[0]?.requestId).not.toBe(requests[1]?.requestId);
  expect(sync.read()?.connectors).toEqual([]);
  expect(sync.epoch()).toBe(0);
});

test('syncFresh starts a new check even after an older poll fails', async () => {
  const release = Promise.withResolvers<void>();
  status = 503;
  hold = release.promise;
  const old = sync.sync();
  const fresh = sync.syncFresh();
  expect(requests).toHaveLength(1);
  status = 200;
  hold = null;
  release.resolve();
  await expect(old).rejects.toBeInstanceOf(ApiError);
  await fresh;
  expect(requests).toHaveLength(2);
  expect(sync.read()?.connectors).toEqual(rows);
});

test('syncFresh force refresh preserves the failed revision even when the old poll installs a new one', async () => {
  rows = rows.map((row) => ({ ...row, revision: Buffer.alloc(32, 23).toString('base64url') }));
  const release = Promise.withResolvers<void>();
  hold = release.promise;
  const old = sync.sync();
  const refresh = { connectorId: 'conn0000001', revision: REVISION };
  const fresh = sync.syncFresh(refresh);
  expect(requests).toHaveLength(1);
  hold = null;
  release.resolve();
  await Promise.all([old, fresh]);
  expect(requests).toHaveLength(2);
  expect(requests[1]?.refresh).toEqual(refresh);
});

test('a throwing listener cannot stop installation, other listeners or cleanup, and its error is never logged', async () => {
  const warnings = spyOn(log, 'warn');
  const seen: (DeliverySnapshot | null)[] = [];
  const stop = sync.onChange(() => { throw new Error(SECRET); });
  sync.onChange(() => { seen.push(sync.read()); });
  try {
    await sync.sync();
    sync.invalidate();
    expect(seen.map((value) => value?.connectors.length ?? null)).toEqual([1, null]);
    expect(warnings.mock.calls).toHaveLength(2);
    expect(JSON.stringify(warnings.mock.calls)).not.toContain(SECRET);
  } finally {
    stop();
    warnings.mockRestore();
  }
});
