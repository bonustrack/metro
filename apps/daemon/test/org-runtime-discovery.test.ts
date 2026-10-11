import { afterEach, beforeEach, expect, test } from 'bun:test';
import { ApiError } from '@metro-labs/http/api-error';
import { sealConnectorDelivery } from '@metro-labs/http/connector-delivery';
import { expectStatus, RELAY_ID, revision, runtimeFixture, type RuntimeFixture } from './org-runtime-fixture.ts';

let fixture: RuntimeFixture;
beforeEach(async () => { fixture = await runtimeFixture(); });
afterEach(() => { fixture.close(); });

test('initialize, initialized, every list page and DELETE each use a fresh signed check and latest header', async () => {
  fixture.state.deliver = async (context, snapshot) => Response.json({ sealed: sealConnectorDelivery(fixture.state.key.sealingKey, context, {
    ...snapshot, connectors: snapshot.connectors.map((row) => ({ ...row, headers: { Authorization: `Bearer current-${fixture.calls.length}` }, revision: revision(fixture.calls.length) })),
  }) });
  const session = fixture.runtime.open(RELAY_ID);
  await session.target(false);
  expect(fixture.vendors.map((call) => call.rpc || call.method)).toEqual(['initialize', 'notifications/initialized', 'tools/list', 'tools/list', 'DELETE']);
  for (let i = 0; i < fixture.vendors.length; i += 1) {
    const call = fixture.vendors[i]!;
    expect(call.headers.get('authorization')).toBe(`Bearer current-${call.checks}`);
    expect(call.checks).toBe(i + 3);
    expect(call.signal.aborted).toBe(false);
  }
  expect(fixture.calls.length).toBe(fixture.vendors.at(-1)!.checks + 1);
  expect(session.current()).toMatchObject({ headers: { Authorization: `Bearer current-${fixture.calls.length}` } });
});

test.each([0, 1, 2, 3, 4])('revocation before discovery stage %s prevents that vendor request', async (stage) => {
  fixture.state.deliver = async (context, snapshot) => {
    if (fixture.calls.length > 2 && fixture.vendors.length === stage) snapshot.connectors = [];
    return Response.json({ sealed: sealConnectorDelivery(fixture.state.key.sealingKey, context, snapshot) });
  };
  const session = fixture.runtime.open(RELAY_ID);
  await expectStatus(() => session.target(false), 404);
  expect(fixture.vendors).toHaveLength(stage);
  expect(session.signal.aborted).toBe(true);
  expect(fixture.publications.at(-1)).toEqual([]);
});

test.each(['assignment', 'policy', 'target', 'epoch'] as const)('a stale response after %s change cannot republish its tool groups', async (change) => {
  const reached = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  fixture.state.vendor = async (call) => {
    if (call.rpc !== 'tools/list') return null;
    reached.resolve();
    await release.promise;
    return Response.json({ result: { tools: [{ name: 'stale_read', annotations: { readOnlyHint: true } }] } });
  };
  const session = fixture.runtime.open(RELAY_ID);
  const running = session.target(false);
  await reached.promise;
  if (change === 'assignment') fixture.state.rows = [];
  else if (change === 'policy') fixture.state.rows = fixture.state.rows.map((row) => ({ ...row, policy: { read: 'deny', write: 'deny' } }));
  else if (change === 'target') fixture.state.rows = fixture.state.rows.map((row) => ({ ...row, url: 'https://new.example/mcp' }));
  else fixture.sync.invalidate();
  if (change !== 'epoch') await fixture.sync.sync();
  expect(session.signal.aborted).toBe(true);
  expect(fixture.vendors.at(-1)?.signal.aborted).toBe(true);
  release.resolve();
  await expectStatus(() => running, change === 'assignment' ? 404 : 503);
  expect(JSON.stringify(fixture.publications)).not.toContain('stale_read');
  expect(fixture.vendors).toHaveLength(3);
});

test('a final fresh delivery after discovery rejects revocation during discovery', async () => {
  fixture.state.vendor = async (call) => {
    if (call.method === 'DELETE') fixture.state.rows = [];
    return null;
  };
  await expectStatus(() => fixture.runtime.open(RELAY_ID).target(false), 404);
  expect(fixture.vendors.at(-1)?.method).toBe('DELETE');
  expect(fixture.publications.at(-1)).toEqual([]);
});

test('a pending older poll cannot count as the new forwarding authorization', async () => {
  const session = fixture.runtime.open(RELAY_ID);
  await session.target(false);
  const reached = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let first = true;
  fixture.state.deliver = async (context, snapshot) => {
    if (first) {
      first = false;
      reached.resolve();
      await release.promise;
    } else snapshot.connectors = [];
    return Response.json({ sealed: sealConnectorDelivery(fixture.state.key.sealingKey, context, snapshot) });
  };
  const oldPoll = fixture.sync.sync();
  await reached.promise;
  const count = fixture.calls.length;
  const next = session.target(false);
  release.resolve();
  await oldPoll;
  await expectStatus(() => next, 404);
  expect(fixture.calls).toHaveLength(count + 1);
});

test('concurrent first requests share one discovery scan', async () => {
  const reached = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  fixture.state.vendor = async (call) => {
    if (call.rpc === 'initialize') { reached.resolve(); await release.promise; }
    return null;
  };
  const first = fixture.runtime.open(RELAY_ID).target(false);
  await reached.promise;
  const second = fixture.runtime.open(RELAY_ID).target(false);
  await Bun.sleep(5);
  expect(fixture.vendors).toHaveLength(1);
  release.resolve();
  await Promise.all([first, second]);
  expect(fixture.vendors.filter((call) => call.rpc === 'initialize')).toHaveLength(1);
  expect(fixture.vendors).toHaveLength(5);
});

test.each([401, 403])('repeated vendor %s fails closed after one refresh without local signout', async (status) => {
  fixture.state.vendor = async () => new Response('org-access-secret', { status });
  await expectStatus(() => fixture.runtime.open(RELAY_ID).target(false), 424);
  expect(fixture.vendors).toHaveLength(2);
  expect(fixture.calls.filter((call) => call.refresh !== undefined)).toHaveLength(1);
  expect(fixture.sync.read()?.connectors[0]?.state).toBe('ready');
  await expectStatus(() => fixture.runtime.open(RELAY_ID).target(false), 424);
  expect(fixture.vendors).toHaveLength(2);
});

test('DELETE authorization failure cannot silently publish a successful scan', async () => {
  fixture.state.vendor = async (call) => call.method === 'DELETE' ? new Response(null, { status: 401 }) : null;
  await expectStatus(() => fixture.runtime.open(RELAY_ID).target(false), 424);
  expect(fixture.publications.at(-1)?.[0]?.config.toolGroups).toEqual({});
});

test.each([424, 503])('injected transport ApiError %s is preserved without sensitive causes', async (status) => {
  fixture.state.vendor = async () => { throw new ApiError('https://vendor.example org-access-secret org-url-secret', status); };
  await expectStatus(() => fixture.runtime.open(RELAY_ID).target(false), status);
  expect(fixture.publications.at(-1)?.[0]?.config.toolGroups).toEqual({});
});

test('manual redirects and oversized discovery responses fail closed', async () => {
  fixture.state.vendor = async () => new Response(null, { status: 302, headers: { location: 'https://elsewhere.example' } });
  await expectStatus(() => fixture.runtime.open(RELAY_ID).target(false), 502);
  fixture.sync.invalidate();
  await fixture.sync.sync();
  fixture.state.vendor = async () => new Response('x'.repeat(2 * 1024 * 1024 + 1));
  await expectStatus(() => fixture.runtime.open(RELAY_ID).target(false), 503);
  expect(fixture.vendors).toHaveLength(2);
});
