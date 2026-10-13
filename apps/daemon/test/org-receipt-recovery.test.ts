import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { log } from '@metro-labs/core/log';
import { expectStatus } from './org-runtime-fixture.ts';
import { OTHER, SECRET, SyncControlFixture, URL_SECRET, within } from './org-sync-control-fixture.ts';

let fixture: SyncControlFixture;
beforeEach(async () => {
  fixture = await SyncControlFixture.create();
  process.env.METRO_CONNECTORS_SYNC_ENABLED = 'true';
  process.env.METRO_CONNECTORS_LIVE_ENABLED = 'true';
  const first = fixture.rows[0]!;
  fixture.rows = [first, ...['conn0000002', 'conn0000003'].map((id) => ({ id, name: first.name, url: first.url, auth: 'none' as const, headers: {}, policy: first.policy, revision: first.revision, state: 'ready' as const }))];
});
afterEach(async () => { await fixture.cleanup(); });

const open = (id = 'conn0000001') => fixture.control.open(`org-${id}`);

test('first request obtains a missing receipt before opening runtime metadata', async () => {
  expect(fixture.control.status().state).toBe('waiting');
  const session = await open();
  expect(session.current().kind).toBe('ok');
  expect(fixture.calls).toHaveLength(1);
  expect(fixture.calls[0]?.signatureValid).toBe(true);
  expect(fixture.control.status().state).toBe('received');
  session.close();
});

test('one credential expiry cannot strand unrelated connectors until the next poll', async () => {
  fixture.rows[0]!.expiresAt = fixture.now + 5000;
  await fixture.control.poll();
  const stale = await open();
  const oldCount = fixture.calls.length;
  fixture.clock += 5001;
  fixture.now += 5001;
  expect(fixture.control.status().state).toBe('expired');
  expect(stale.signal.aborted).toBe(true);
  fixture.rows[0]!.expiresAt = fixture.now + 3_600_000;
  const sessions = await Promise.all(fixture.rows.map((row) => open(row.id)));
  expect(fixture.calls).toHaveLength(oldCount + 1);
  for (const session of sessions) { expect(session.current().kind).toBe('ok'); session.close(); }
  await expectStatus(() => stale.current(), 503);
  stale.close();
});

test('concurrent startup requests share one receipt recovery', async () => {
  const held = fixture.hold();
  const first = open();
  await within(held.reached);
  const others = Array.from({ length: 8 }, () => open());
  expect(fixture.calls).toHaveLength(1);
  held.release();
  const sessions = await within(Promise.all([first, ...others]));
  expect(fixture.calls).toHaveLength(1);
  for (const session of sessions) session.close();
});

test('an expired pending poll is discarded before one shared new recovery', async () => {
  await fixture.control.poll();
  const held = fixture.hold();
  const old = fixture.control.poll().catch((error: unknown) => error);
  await within(held.reached);
  fixture.clock += 90_001;
  fixture.now += 90_001;
  fixture.rows[0]!.expiresAt = fixture.now + 120_000;
  const pending = [open(), open('conn0000002')];
  fixture.beforeReply = null;
  held.release();
  await old;
  const sessions = await within(Promise.all(pending));
  expect(fixture.calls).toHaveLength(3);
  expect(new Set(fixture.calls.map((call) => call.body.requestId)).size).toBe(3);
  for (const session of sessions) session.close();
});

test.each([401, 403, 503])('central %s during recovery fails closed and a later request can recover', async (status) => {
  fixture.responseStatus = status;
  const debug = spyOn(log, 'debug');
  try {
    await expectStatus(() => open(), status === 503 ? 503 : 424);
    expect(fixture.control.status().state).toBe('unavailable');
    expect(debug.mock.calls).toContainEqual([{ stage: 'receipt_open', state: 'waiting', status: status === 503 ? 503 : 424 }, 'organization connectors: request unavailable']);
    for (const secret of [SECRET, URL_SECRET, 'mcp.example']) expect(JSON.stringify(debug.mock.calls)).not.toContain(secret);
    fixture.responseStatus = 200;
    const session = await open();
    expect(session.current().kind).toBe('ok');
    expect(fixture.calls).toHaveLength(2);
    session.close();
  } finally { debug.mockRestore(); }
});

test('a revoked assignment is not restored by receipt recovery', async () => {
  await fixture.control.poll();
  fixture.clock += 90_001;
  fixture.now += 90_001;
  fixture.rows = [];
  await expectStatus(() => open(), 404);
  expect(fixture.control.status().counts?.total).toBe(0);
  expect(fixture.calls).toHaveLength(2);
});

test.each(['off', 'owner', 'stop'] as const)('%s while recovery waits cannot revive the old runtime', async (change) => {
  const held = fixture.hold();
  const pending = open();
  await within(held.reached);
  if (change === 'off') fixture.control.set(false, fixture.control.status().scope);
  else if (change === 'owner') { fixture.owner = OTHER; fixture.control.status(); }
  else fixture.control.stop();
  held.release();
  await expectStatus(() => within(pending), 503);
});

test('sync and LIVE disabled do not fetch a receipt just because a request arrived', async () => {
  for (const flag of ['METRO_CONNECTORS_SYNC_ENABLED', 'METRO_CONNECTORS_LIVE_ENABLED']) {
    process.env[flag] = 'false';
    fixture.restart();
    await expectStatus(() => open(), 503);
    process.env[flag] = 'true';
  }
  expect(fixture.calls).toHaveLength(0);
});
