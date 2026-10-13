import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sealConnectorDelivery } from '@metro-labs/http/connector-delivery';
import { orgConnectorRelaySession, stopOrgConnectorSync, watchOrgConnectorSync } from '../src/connectors/org-sync-watch.ts';
import { enrolledKey, expectStatus, ID, OWNER, RELAY_ID, revision, runtimeFixture, type RuntimeFixture } from './org-runtime-fixture.ts';

let fixture: RuntimeFixture;
beforeEach(async () => { fixture = await runtimeFixture(); });
afterEach(() => { fixture.close(); stopOrgConnectorSync(); });

const readyTarget = async () => {
  const session = fixture.runtime.open(RELAY_ID);
  await session.target(false);
  session.current();
  return session;
};

test('publication carries only source-qualified metadata and unknown tools stay write', async () => {
  const { runtime, publications } = fixture;
  expect(publications.at(-1)).toEqual([{ id: RELAY_ID, name: 'Org MCP', config: { policy: { write: 'deny' }, toolGroups: {} } }]);
  const session = runtime.open(RELAY_ID);
  expect(session.blocker()(RELAY_ID, 'unknown_tool', {})).toContain('Blocked');
  await session.target(false);
  const published = publications.at(-1)?.[0];
  expect(published?.config.toolGroups).toEqual({ read_item: 'read', write_item: 'write' });
  expect(session.blocker()(RELAY_ID, 'read_item', {})).toBeNull();
  expect(session.blocker()(RELAY_ID, 'unknown_tool', {})).toContain('Blocked');
  const text = JSON.stringify(publications);
  for (const privateValue of ['org-url-secret', 'org-access-secret', revision(1), 'https:', 'headers', 'description']) expect(text).not.toContain(privateValue);
});

test('every target requires a fresh delivery even with a valid lease and cached groups', async () => {
  const session = await readyTarget();
  const checks = fixture.calls.length;
  const vendors = fixture.vendors.length;
  await session.target(false);
  expect(fixture.calls).toHaveLength(checks + 1);
  expect(fixture.vendors).toHaveLength(vendors);
  expect(fixture.calls.at(-1)?.refresh).toBeUndefined();
});

test('forced retry names the actual attempt revision, not a newer poll', async () => {
  const session = await readyTarget();
  fixture.state.rows = fixture.state.rows.map((row) => ({ ...row, revision: revision(2), headers: { Authorization: 'Bearer second' } }));
  await fixture.sync.sync();
  expect(session.signal.aborted).toBe(false);
  await session.target(true);
  expect(fixture.calls.at(-1)?.refresh).toEqual({ connectorId: ID, revision: revision(1) });
  expect(session.current()).toMatchObject({ headers: { Authorization: 'Bearer second' } });
  expect(JSON.stringify(fixture.calls)).not.toContain('org-access-secret');
});

test('assignment revocation immediately aborts sessions and cannot be undone by reassignment', async () => {
  const session = await readyTarget();
  const saved = fixture.state.rows;
  fixture.state.rows = [];
  await fixture.sync.sync();
  expect(session.signal.aborted).toBe(true);
  expect(fixture.publications.at(-1)).toEqual([]);
  await expectStatus(() => session.current(), 404);
  fixture.state.rows = saved;
  await fixture.sync.sync();
  await expectStatus(() => session.target(false), 404);
});

test.each(['policy', 'target', 'name'] as const)('%s changes abort an active request without using a new target', async (change) => {
  const session = await readyTarget();
  fixture.state.rows = fixture.state.rows.map((row) => change === 'policy' ? { ...row, policy: { read: 'deny', write: 'deny' } } : change === 'target' ? { ...row, url: 'https://other.example/mcp' } : { ...row, name: 'Renamed' });
  await fixture.sync.sync();
  expect(session.signal.aborted).toBe(true);
  await expectStatus(() => session.current(), 503);
});

test.each(['owner', 'key', 'invalidation'] as const)('%s invalidation never resumes an old session after identity returns', async (change) => {
  const session = await readyTarget();
  const original = fixture.state.key;
  if (change === 'owner') fixture.state.owner = 'org_01OTHEROWNER000';
  else if (change === 'key') fixture.state.key = enrolledKey();
  else fixture.sync.invalidate();
  fixture.sync.read();
  expect(session.signal.aborted).toBe(true);
  fixture.state.owner = OWNER;
  fixture.state.key = original;
  await fixture.sync.sync();
  await expectStatus(() => session.current(), 503);
  expect(fixture.runtime.open(RELAY_ID).signal.aborted).toBe(false);
});

test('a pending fresh request cannot send after owner changes away and back', async () => {
  const session = fixture.runtime.open(RELAY_ID);
  const reached = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  fixture.state.deliver = async (context, snapshot) => {
    reached.resolve();
    await release.promise;
    return Response.json({ sealed: sealConnectorDelivery(fixture.state.key.sealingKey, context, snapshot) });
  };
  const target = session.target(false);
  await reached.promise;
  fixture.state.owner = 'org_01OTHEROWNER000';
  fixture.sync.invalidate();
  fixture.state.owner = OWNER;
  release.resolve();
  await expectStatus(() => target, 503);
  expect(fixture.vendors).toEqual([]);
  expect(session.signal.aborted).toBe(true);
});

test.each([401, 403, 502, 503])('central %s fails closed with safe daemon status and aborts active requests', async (status) => {
  const active = await readyTarget();
  const session = fixture.runtime.open(RELAY_ID);
  fixture.state.deliver = async () => Response.json({ error: 'org-access-secret https://vendor.example?org-url-secret' }, { status });
  const count = fixture.vendors.length;
  await expectStatus(() => session.target(false), status >= 500 ? 503 : 424);
  expect(fixture.vendors).toHaveLength(count);
  expect(active.signal.aborted).toBe(true);
  if (status >= 500) expect(fixture.publications.at(-1)?.map((row) => row.id)).toEqual([RELAY_ID]);
  else expect(fixture.publications.at(-1)).toEqual([]);
});

test('missing, signin and unavailable assignments keep distinct safe statuses, stay listed, and leave the list once unassigned', async () => {
  await expectStatus(() => fixture.runtime.open('org-absent00001'), 404);
  for (const [state, status] of [['signin', 424], ['unavailable', 503]] as const) {
    fixture.state.rows = fixture.state.rows.map((row) => ({ ...row, state, headers: {} }));
    await fixture.sync.sync();
    await expectStatus(() => fixture.runtime.open(RELAY_ID), status);
    expect(fixture.publications.at(-1)?.map((row) => row.id)).toEqual([RELAY_ID]);
  }
  fixture.state.rows = [];
  await fixture.sync.sync();
  expect(fixture.publications.at(-1)).toEqual([]);
});

test('monotonic expiry and real expiry timer both abort requests but keep the published list until the next delivery', async () => {
  const session = await readyTarget();
  fixture.state.monotonic += 90_001;
  await expectStatus(() => session.current(), 503);
  expect(session.signal.aborted).toBe(true);
  fixture.state.lease = 25;
  await fixture.sync.sync();
  const expiring = fixture.runtime.open(RELAY_ID);
  await Bun.sleep(40);
  expect(expiring.signal.aborted).toBe(true);
  expect(fixture.publications.at(-1)?.map((row) => row.id)).toEqual([RELAY_ID]);
  const first = fixture.publications.findIndex((rows) => rows.length > 0);
  expect(fixture.publications.slice(first).some((rows) => rows.length === 0)).toBe(false);
});

test('nothing is published before the first delivery, and a shutdown keeps the last list while sync off clears it', async () => {
  expect(fixture.publications.map((rows) => rows.map((row) => row.id))).toEqual([[RELAY_ID]]);
  const session = await readyTarget();
  fixture.runtime.stop(true);
  expect(session.signal.aborted).toBe(true);
  expect(fixture.publications.at(-1)?.map((row) => row.id)).toEqual([RELAY_ID]);
  fixture.close();
  fixture = await runtimeFixture();
  fixture.runtime.stop();
  expect(fixture.publications.at(-1)).toEqual([]);
});

test('live and sync flags fail closed without changing local files', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'metro-org-runtime-'));
  const path = join(dir, 'connectors.json');
  const original = '{"connectors":[{"id":"local000001","name":"Local","config":{"value":"local-secret"}}]}';
  writeFileSync(path, original);
  try {
    const session = await readyTarget();
    fixture.state.live = false;
    await expectStatus(() => session.current(), 503);
    expect(session.signal.aborted).toBe(true);
    fixture.state.live = true;
    fixture.state.syncEnabled = false;
    await expectStatus(() => fixture.runtime.open(RELAY_ID), 503);
    expect(readFileSync(path, 'utf8')).toBe(original);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('watcher flags default off independently and organization references never fall back to local', async () => {
  const previous = [process.env.METRO_CONNECTORS_SYNC_ENABLED, process.env.METRO_CONNECTORS_LIVE_ENABLED];
  let checks = 0;
  try {
    for (const live of [undefined, 'true']) {
      delete process.env.METRO_CONNECTORS_SYNC_ENABLED;
      if (live === undefined) delete process.env.METRO_CONNECTORS_LIVE_ENABLED;
      else process.env.METRO_CONNECTORS_LIVE_ENABLED = live;
      watchOrgConnectorSync({ owner: () => { checks += 1; return OWNER; }, key: () => fixture.state.key });
      expect(checks).toBe(0);
      expect(orgConnectorRelaySession('local000001')).toBeNull();
      await expectStatus(() => orgConnectorRelaySession(RELAY_ID), 503);
    }
    process.env.METRO_CONNECTORS_SYNC_ENABLED = 'true';
    delete process.env.METRO_CONNECTORS_LIVE_ENABLED;
    watchOrgConnectorSync({ owner: () => null, key: () => fixture.state.key });
    await expectStatus(() => orgConnectorRelaySession(RELAY_ID), 503);
  } finally {
    stopOrgConnectorSync();
    for (const [i, name] of ['METRO_CONNECTORS_SYNC_ENABLED', 'METRO_CONNECTORS_LIVE_ENABLED'].entries()) {
      if (previous[i] === undefined) delete process.env[name];
      else process.env[name] = previous[i];
    }
  }
});

test('stop aborts all requests, clears metadata and unsubscribes', async () => {
  const session = await readyTarget();
  fixture.runtime.stop();
  expect(session.signal.aborted).toBe(true);
  expect(fixture.publications.at(-1)).toEqual([]);
  const count = fixture.publications.length;
  await fixture.sync.sync();
  expect(fixture.publications).toHaveLength(count);
  await expectStatus(() => fixture.runtime.open(RELAY_ID), 503);
});
