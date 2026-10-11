import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { sealConnectorDelivery } from '@metro-labs/http/connector-delivery';
import { enrolledKey, expectStatus, ID, RELAY_ID, revision, runtimeFixture, type RuntimeFixture } from './org-runtime-fixture.ts';

let fixture: RuntimeFixture;
beforeEach(async () => { fixture = await runtimeFixture(); });
afterEach(() => { fixture.close(); });

const forced = () => fixture.calls.filter((call) => call.refresh !== undefined);

function rotateOnRefresh(): void {
  fixture.state.deliver = async (context, snapshot) => {
    if (fixture.calls.at(-1)?.refresh !== undefined) fixture.state.rows = fixture.state.rows.map((row) => ({ ...row, revision: revision(2), headers: { Authorization: 'Bearer refreshed' } }));
    return Response.json({ sealed: sealConnectorDelivery(fixture.state.key.sealingKey, context, { ...snapshot, connectors: fixture.state.rows }) });
  };
}

test.each([401, 403])('an early OAuth discovery %s refreshes once and completes with the rotated credential', async (status) => {
  rotateOnRefresh();
  fixture.state.vendor = async (call) => call.headers.get('authorization') === 'Bearer refreshed' ? null : new Response(null, { status });
  const session = fixture.runtime.open(RELAY_ID);
  await session.target(false);
  expect(forced().map((call) => call.refresh)).toEqual([{ connectorId: ID, revision: revision(1) }]);
  expect(fixture.vendors.filter((call) => call.rpc === 'initialize')).toHaveLength(2);
  expect(fixture.vendors[1]?.checks).toBe(fixture.vendors[0]!.checks + 1);
  expect(fixture.vendors.slice(1).every((call) => call.headers.get('authorization') === 'Bearer refreshed')).toBe(true);
  expect(session.current()).toMatchObject({ headers: { Authorization: 'Bearer refreshed' } });
  expect(fixture.publications.at(-1)?.[0]?.config.toolGroups).toEqual({ read_item: 'read', write_item: 'write' });
});

test('discovery refresh names the rejected dispatch revision even when a poll installed a newer token', async () => {
  const reached = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let rejected = false;
  fixture.state.vendor = async () => {
    if (rejected) return null;
    rejected = true;
    reached.resolve();
    await release.promise;
    return new Response(null, { status: 401 });
  };
  const running = fixture.runtime.open(RELAY_ID).target(false);
  await reached.promise;
  fixture.state.rows = fixture.state.rows.map((row) => ({ ...row, revision: revision(2), headers: { Authorization: 'Bearer polled' } }));
  await fixture.sync.sync();
  release.resolve();
  await running;
  expect(forced().map((call) => call.refresh)).toEqual([{ connectorId: ID, revision: revision(1) }]);
  expect(fixture.vendors[0]?.headers.get('authorization')).toBe('Bearer org-access-secret');
  expect(fixture.vendors[1]?.headers.get('authorization')).toBe('Bearer polled');
});

test.each(['assignment', 'policy', 'owner', 'key', 'invalidation'] as const)('%s changes during forced discovery refresh prevent its vendor retry', async (change) => {
  const reached = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  fixture.state.vendor = async () => new Response(null, { status: 401 });
  fixture.state.deliver = async (context, snapshot) => {
    if (fixture.calls.at(-1)?.refresh !== undefined) {
      reached.resolve();
      await release.promise;
    }
    return Response.json({ sealed: sealConnectorDelivery(fixture.state.key.sealingKey, context, { ...snapshot, connectors: fixture.state.rows }) });
  };
  const session = fixture.runtime.open(RELAY_ID);
  const running = session.target(false);
  await reached.promise;
  if (change === 'assignment') fixture.state.rows = [];
  else if (change === 'policy') fixture.state.rows = fixture.state.rows.map((row) => ({ ...row, policy: { read: 'deny', write: 'deny' } }));
  else if (change === 'owner') fixture.state.owner = 'org_01OTHEROWNER000';
  else if (change === 'key') fixture.state.key = enrolledKey();
  else fixture.sync.invalidate();
  release.resolve();
  await expectStatus(() => running, change === 'assignment' ? 404 : 503);
  expect(fixture.vendors).toHaveLength(1);
  expect(forced()).toHaveLength(1);
  expect(session.signal.aborted).toBe(true);
  expect(fixture.publications.at(-1)?.[0]?.config.toolGroups ?? {}).toEqual({});
});

test('one refresh budget covers the whole paginated discovery scan', async () => {
  let firstPageRejected = false;
  rotateOnRefresh();
  fixture.state.vendor = async (call) => {
    if (call.rpc !== 'tools/list') return null;
    if ((call.body.params as Record<string, unknown>).cursor === 'second') return new Response(null, { status: 403 });
    if (firstPageRejected) return null;
    firstPageRejected = true;
    return new Response(null, { status: 401 });
  };
  await expectStatus(() => fixture.runtime.open(RELAY_ID).target(false), 424);
  expect(forced()).toHaveLength(1);
  expect(fixture.vendors.filter((call) => call.rpc === 'tools/list')).toHaveLength(3);
  expect(fixture.publications.at(-1)?.[0]?.config.toolGroups).toEqual({});
});

test.each(['header', 'none'] as const)('%s discovery credentials never request an OAuth refresh', async (auth) => {
  fixture.state.rows = fixture.state.rows.map((row) => ({ ...row, auth, headers: auth === 'header' ? { 'x-api-key': 'header-key' } : {} }));
  await fixture.sync.sync();
  fixture.state.vendor = async () => new Response(null, { status: 401 });
  await expectStatus(() => fixture.runtime.open(RELAY_ID).target(false), 424);
  expect(fixture.vendors).toHaveLength(1);
  expect(forced()).toEqual([]);
});

test.each([
  ['lease', false], ['owner', false], ['key', false], ['live', false], ['sync', false],
  ['lease', true], ['owner', true], ['key', true], ['live', true], ['sync', true],
] as const)('%s change in the fresh-check async gap prevents discovery dispatch (retry %s)', async (change, retry) => {
  if (retry) fixture.state.vendor = async () => new Response(null, { status: 401 });
  const original = fixture.sync.read.bind(fixture.sync);
  let reads = 0;
  let changed = false;
  const spy = spyOn(fixture.sync, 'read').mockImplementation(() => {
    const snapshot = original();
    if (fixture.calls.length === (retry ? 4 : 3) && ++reads === 2) queueMicrotask(() => {
      changed = true;
      if (change === 'lease') fixture.state.monotonic += 90_001;
      else if (change === 'owner') fixture.state.owner = 'org_01OTHEROWNER000';
      else if (change === 'key') fixture.state.key = enrolledKey();
      else if (change === 'live') fixture.state.live = false;
      else fixture.state.syncEnabled = false;
    });
    return snapshot;
  });
  try {
    const session = fixture.runtime.open(RELAY_ID);
    await expectStatus(() => session.target(false), 503);
    expect(changed).toBe(true);
    expect(fixture.vendors).toHaveLength(retry ? 1 : 0);
    expect(session.signal.aborted).toBe(true);
  } finally {
    spy.mockRestore();
  }
});
