import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { log } from '@metro-labs/core/log';
import { newAgentKey } from '../src/connectors/agent-key.ts';
import { AGENT, OTHER, OWNER, REVISION, SECRET, SyncControlFixture, URL_SECRET, within } from './org-sync-control-fixture.ts';

let f: SyncControlFixture;
beforeEach(async () => { f = await SyncControlFixture.create(); });
afterEach(async () => { await f.cleanup(); });

const enable = (): void => { f.control.set(true, f.control.status().scope); };
const disable = (): void => { f.control.set(false, f.control.status().scope); };

function noSecrets(value: unknown): void {
  const text = JSON.stringify(value);
  for (const secret of [SECRET, URL_SECRET, REVISION, 'Private organization MCP', 'local-only-secret', f.key?.keyId, f.key?.signingKey, f.key?.sealingKey, f.key?.signing.export({ type: 'pkcs8', format: 'der' }).toString('base64')]) {
    if (secret !== undefined) expect(text).not.toContain(secret);
  }
}

test('default OFF and only exact SYNC=true enables the environment fallback; LIVE and central flags do not', async () => {
  expect(f.control.status()).toMatchObject({ enabled: false, source: 'default', state: 'off', enrolled: true, owner: OWNER, agentId: AGENT, liveEnabled: false, counts: null, lastReceivedAt: null, leaseExpiresAt: null });
  for (const value of ['', 'false', 'TRUE', '1', ' true ']) {
    process.env.METRO_CONNECTORS_SYNC_ENABLED = value;
    process.env.METRO_CONNECTORS_ENABLED = 'true';
    process.env.METRO_CONNECTORS_LIVE_ENABLED = 'true';
    f.restart().start();
    await f.control.poll();
    expect(f.control.status()).toMatchObject({ enabled: false, source: 'default', state: 'off', liveEnabled: true });
  }
  expect(f.calls).toEqual([]);
  delete process.env.METRO_CONNECTORS_LIVE_ENABLED;
  process.env.METRO_CONNECTORS_SYNC_ENABLED = 'true';
  f.restart().start();
  await f.control.poll();
  expect(f.control.status()).toMatchObject({ enabled: true, source: 'environment', state: 'received', liveEnabled: false });
  expect(f.calls).toHaveLength(1);
  expect(existsSync(f.setting)).toBe(false);
});

test('saved ON survives restart over env false, saved OFF survives restart over env true', async () => {
  const scope = f.control.status().scope;
  enable();
  await f.control.poll();
  const saved = JSON.parse(readFileSync(f.setting, 'utf8')) as { version: number; enabled: boolean; scope: string };
  expect(saved).toEqual({ version: 1, enabled: true, scope: expect.stringMatching(/^[a-f0-9]{64}$/) });
  expect(statSync(f.setting).mode & 0o777).toBe(0o600);
  process.env.METRO_CONNECTORS_SYNC_ENABLED = 'false';
  f.restart();
  expect(f.control.status().scope).not.toBe(scope);
  expect(() => f.control.set(true, scope)).toThrow('changed');
  expect(f.control.status()).toMatchObject({ enabled: true, source: 'saved', state: 'waiting', counts: null, lastReceivedAt: null, leaseExpiresAt: null });
  f.control.start();
  await f.control.poll();
  expect(f.control.status().state).toBe('received');
  disable();
  process.env.METRO_CONNECTORS_SYNC_ENABLED = 'true';
  const calls = f.calls.length;
  f.restart().start();
  await f.control.poll();
  expect(f.control.status()).toMatchObject({ enabled: false, source: 'saved', state: 'off', counts: null, lastReceivedAt: null, leaseExpiresAt: null });
  expect(f.calls).toHaveLength(calls);
  expect(JSON.parse(readFileSync(f.setting, 'utf8'))).toEqual({ ...saved, enabled: false });
});

test('bad, unreadable and stale saved settings fail OFF rather than fall back to environment ON', async () => {
  process.env.METRO_CONNECTORS_SYNC_ENABLED = 'true';
  const scope = f.control.status().scope;
  for (const text of ['{damaged', 'null', '[]', JSON.stringify({ version: 2, enabled: true, scope }), JSON.stringify({ version: 1, enabled: 'true', scope }), JSON.stringify({ version: 1, enabled: true, scope: 'invalid' })]) {
    writeFileSync(f.setting, text);
    f.restart().start();
    await f.control.poll();
    expect(f.control.status()).toMatchObject({ enabled: false, source: 'invalid', state: 'off', counts: null });
    expect(readFileSync(f.setting, 'utf8')).toBe(text);
  }
  rmSync(f.setting);
  mkdirSync(f.setting);
  f.restart().start();
  await f.control.poll();
  expect(f.control.status()).toMatchObject({ enabled: false, source: 'invalid', state: 'off' });
  rmSync(f.setting, { recursive: true });
  writeFileSync(f.setting, JSON.stringify({ version: 1, enabled: true, scope: 'a'.repeat(64) }));
  f.restart().start();
  await f.control.poll();
  expect(f.control.status()).toMatchObject({ enabled: false, source: 'scope_changed', state: 'off', counts: null });
  expect(f.calls).toEqual([]);
});

test('an unenrolled or mismatched agent never fetches and cannot be enabled', async () => {
  process.env.METRO_CONNECTORS_SYNC_ENABLED = 'true';
  const enrolled = f.key;
  for (const key of [null, newAgentKey(), { ...newAgentKey(), enrollment: { organization: OTHER, server: AGENT, at: new Date(f.now).toISOString() } }]) {
    f.key = key;
    f.restart().start();
    await f.control.poll();
    expect(f.control.status()).toMatchObject({ enabled: true, source: 'environment', enrolled: false, state: 'not_enrolled', agentId: null, counts: null });
    expect(enable).toThrow('Enroll');
    expect(existsSync(f.setting)).toBe(false);
  }
  f.key = enrolled;
  f.owner = null;
  f.restart();
  expect(f.control.status()).toMatchObject({ enrolled: false, owner: null, state: 'not_enrolled' });
  expect(enable).toThrow('Enroll');
  expect(f.calls).toEqual([]);
});

test('LIVE blocks enabling through the control but never blocks saving OFF', async () => {
  process.env.METRO_CONNECTORS_LIVE_ENABLED = 'true';
  expect(enable).toThrow('Live');
  expect(existsSync(f.setting)).toBe(false);
  expect(f.calls).toEqual([]);
  disable();
  expect(f.control.status()).toMatchObject({ enabled: false, source: 'saved', liveEnabled: true, state: 'off' });
  process.env.METRO_CONNECTORS_LIVE_ENABLED = 'TRUE';
  enable();
  await f.control.poll();
  expect(f.control.status()).toMatchObject({ enabled: true, liveEnabled: false, state: 'received' });
  await expect(f.control.open('conn0000001')).rejects.toThrow('not available');
  expect(process.env.METRO_CONNECTORS_LIVE_ENABLED).toBe('TRUE');
});

test('signed and sealed receipt is real, counts only validated delivery, and empty delivery is distinct from waiting', async () => {
  const held = f.hold();
  enable();
  const pending = f.control.poll();
  await within(held.reached);
  expect(f.control.status()).toMatchObject({ enabled: true, state: 'waiting', counts: null, lastReceivedAt: null, leaseExpiresAt: null });
  held.release();
  await pending;
  expect(f.calls).toHaveLength(1);
  expect(f.calls[0]).toMatchObject({ path: '/api/agents/connectors?policy_layers=1', signatureValid: true });
  expect(Object.keys(f.calls[0]?.body ?? {})).toEqual(['requestId']);
  expect(f.calls[0]?.body.requestId).toMatch(/^[A-Za-z0-9_-]{43}$/);
  const receipt = f.control.status();
  expect(receipt).toMatchObject({ state: 'received', counts: { total: 2, ready: 1, unavailable: 1 }, lastReceivedAt: f.now, leaseExpiresAt: f.now + 90_000 });
  if (receipt.counts !== null) receipt.counts.total = 500;
  expect(f.control.status().counts?.total).toBe(2);
  f.rows = [];
  await f.control.poll();
  expect(f.control.status()).toMatchObject({ state: 'received', counts: { total: 0, ready: 0, unavailable: 0 } });
});

for (const expiry of ['monotonic', 'wall', 'credential']) {
  test(`${expiry} expiry removes usable counts without pretending a new receipt`, async () => {
    if (expiry === 'credential') f.rows = f.rows.map((row) => row.state === 'ready' ? { ...row, expiresAt: f.now + 5000 } : row);
    enable();
    await f.control.poll();
    const received = f.control.status();
    if (expiry === 'monotonic') { f.clock += 90_001; f.now -= 300_000; }
    else f.now += expiry === 'wall' ? 90_001 : 5001;
    expect(f.control.status()).toMatchObject({ enabled: true, state: 'expired', counts: null, lastReceivedAt: received.lastReceivedAt, leaseExpiresAt: received.leaseExpiresAt });
    expect(f.calls).toHaveLength(1);
  });
}

test('a corrupt sealed response and an upstream refusal clear counts and never leak secrets into status or logs', async () => {
  const warnings = spyOn(log, 'warn');
  const infos = spyOn(log, 'info');
  const debugs = spyOn(log, 'debug');
  const errors = spyOn(log, 'error');
  try {
    enable();
    await f.control.poll();
    const received = f.control.status().lastReceivedAt;
    f.invalidSeal = true;
    await expect(f.control.poll()).rejects.toThrow();
    expect(f.control.status()).toMatchObject({ state: 'unavailable', counts: null, lastReceivedAt: received });
    f.invalidSeal = false;
    f.responseStatus = 503;
    f.control.start();
    await expect(f.control.poll()).rejects.toThrow();
    noSecrets([f.control.status(), f.calls, warnings.mock.calls, infos.mock.calls, debugs.mock.calls, errors.mock.calls]);
  } finally {
    warnings.mockRestore();
    infos.mockRestore();
    debugs.mockRestore();
    errors.mockRestore();
  }
});

test('memory-only control never modifies local connectors, policy, enrollment keys or plugin publication', async () => {
  const before = f.files();
  enable();
  await f.control.poll();
  noSecrets(f.control.status());
  noSecrets(readFileSync(f.setting, 'utf8'));
  const after = f.files();
  delete after['org-connector-sync.json'];
  expect(after).toEqual(before);
  await expect(f.control.open('conn0000001')).rejects.toThrow('not available');
  disable();
  const disabled = f.files();
  delete disabled['org-connector-sync.json'];
  expect(disabled).toEqual(before);
});

test('saving OFF aborts the real in-flight HTTP request and its late response cannot restore memory', async () => {
  const held = f.hold();
  enable();
  const pending = f.control.poll().then(() => null, (err: unknown) => err);
  await within(held.reached);
  const signal = f.signals[0];
  expect(signal?.aborted).toBe(false);
  disable();
  expect(signal?.aborted).toBe(true);
  await within(held.closed);
  held.release();
  await within(pending);
  expect(f.control.status()).toMatchObject({ enabled: false, state: 'off', counts: null, lastReceivedAt: null, leaseExpiresAt: null });
});

test('a response already received before OFF cannot repopulate memory even when its transport ignores abort', async () => {
  const reached = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  f.releases.push(release.resolve);
  f.afterFetch = async () => { reached.resolve(); await release.promise; };
  enable();
  const pending = f.control.poll().then(() => null, (err: unknown) => err);
  await within(reached.promise);
  disable();
  expect(f.signals[0]?.aborted).toBe(true);
  release.resolve();
  await within(pending);
  expect(f.control.status()).toMatchObject({ enabled: false, state: 'off', counts: null, lastReceivedAt: null });
});

for (const change of ['owner', 'key', 'server']) {
  test(`${change} changes clear prior receipt, bind a new scope and never resurrect saved ON on restart or return`, async () => {
    enable();
    await f.control.poll();
    const originalKey = f.key;
    const oldScope = f.control.status().scope;
    if (change === 'owner') f.owner = OTHER;
    if (change === 'key') f.key = { ...newAgentKey(), enrollment: originalKey?.enrollment ?? null };
    if (change === 'server' && originalKey?.enrollment !== null && originalKey?.enrollment !== undefined) f.key = { ...originalKey, enrollment: { ...originalKey.enrollment, server: 'agent000002' } };
    const next = f.control.status();
    expect(next.scope).not.toBe(oldScope);
    expect(next).toMatchObject({ enabled: false, source: 'scope_changed', state: 'off', counts: null, lastReceivedAt: null, leaseExpiresAt: null });
    expect(() => f.control.set(true, oldScope)).toThrow('changed');
    expect(JSON.parse(readFileSync(f.setting, 'utf8'))).toMatchObject({ enabled: false });
    process.env.METRO_CONNECTORS_SYNC_ENABLED = 'true';
    f.restart().start();
    await f.control.poll();
    expect(f.control.status().enabled).toBe(false);
    f.owner = OWNER;
    f.key = originalKey;
    f.restart().start();
    await f.control.poll();
    expect(f.control.status()).toMatchObject({ enabled: false, state: 'off', counts: null, lastReceivedAt: null });
    expect(f.calls).toHaveLength(1);
  });
}

test('a saved ON for a previous enrollment fails closed on the first boot with its replacement', async () => {
  enable();
  await f.control.poll();
  const oldKey = f.key;
  const oldSetting = readFileSync(f.setting, 'utf8');
  f.control.stop();
  f.key = { ...newAgentKey(), enrollment: oldKey?.enrollment ?? null };
  process.env.METRO_CONNECTORS_SYNC_ENABLED = 'true';
  f.restart().start();
  await f.control.poll();
  expect(f.control.status()).toMatchObject({ enabled: false, source: 'scope_changed', state: 'off', counts: null, lastReceivedAt: null });
  expect(readFileSync(f.setting, 'utf8')).not.toBe(oldSetting);
  f.key = oldKey;
  f.restart().start();
  await f.control.poll();
  expect(f.control.status()).toMatchObject({ enabled: false, source: 'saved', state: 'off' });
  expect(f.calls).toHaveLength(1);
});

test('key rotation aborts a pending poll before any snapshot exists and invalidates the old scope', async () => {
  const held = f.hold();
  const oldScope = f.control.status().scope;
  enable();
  const pending = f.control.poll().then(() => null, (err: unknown) => err);
  await within(held.reached);
  f.key = { ...newAgentKey(), enrollment: f.key?.enrollment ?? null };
  expect(f.control.status()).toMatchObject({ enabled: false, source: 'scope_changed', state: 'off', counts: null, lastReceivedAt: null });
  expect(f.signals[0]?.aborted).toBe(true);
  expect(() => f.control.set(true, oldScope)).toThrow('changed');
  held.release();
  await within(pending);
  expect(f.control.status().counts).toBeNull();
});

test('a snapshot whose lease expires in transit never becomes a successful receipt', async () => {
  const held = f.hold();
  enable();
  const pending = f.control.poll().then(() => null, (err: unknown) => err);
  await within(held.reached);
  f.clock += 90_001;
  held.release();
  expect(await within(pending)).toBeInstanceOf(Error);
  expect(f.control.status()).toMatchObject({ state: 'unavailable', counts: null, lastReceivedAt: null, leaseExpiresAt: null });
});

test('stop aborts a pending request but preserves saved ON for a new controller', async () => {
  const held = f.hold();
  enable();
  const pending = f.control.poll().then(() => null, (err: unknown) => err);
  await within(held.reached);
  f.control.stop();
  expect(f.signals[0]?.aborted).toBe(true);
  held.release();
  await within(pending);
  f.beforeReply = null;
  expect(f.restart().status()).toMatchObject({ enabled: true, source: 'saved', state: 'waiting', counts: null });
  f.control.start();
  await f.control.poll();
  expect(f.control.status().state).toBe('received');
});

test('an owner event during a pending request aborts it and clears saved ON even if the identity returns', async () => {
  const held = f.hold();
  enable();
  const pending = f.control.poll().then(() => null, (err: unknown) => err);
  await within(held.reached);
  f.owner = OTHER;
  f.control.invalidate();
  expect(f.signals[0]?.aborted).toBe(true);
  f.owner = OWNER;
  held.release();
  await within(pending);
  expect(f.control.status()).toMatchObject({ enabled: false, source: 'saved', counts: null, lastReceivedAt: null });
  f.restart().start();
  await f.control.poll();
  expect(f.calls).toHaveLength(1);
});
