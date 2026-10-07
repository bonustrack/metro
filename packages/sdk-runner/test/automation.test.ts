import { afterEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { AutomationStore } from '@metro-labs/core/automation-store';
import type { AutomationResolution, AutomationStatus } from '@metro-labs/core/automation-types';
import { Automation } from '../src/automation.ts';
import { automationShellCommand } from '../src/automation-command.ts';
import { Inbox } from '../src/inbox.ts';
import { SessionWatch } from '../src/session-watch.ts';
import { Runner } from '../src/runner.ts';
import { SessionStore } from '../src/session-store.ts';

const roots: string[] = [];
const pumps: Automation[] = [];
const inboxes: Inbox[] = [];
afterEach(() => {
  for (const pump of pumps.splice(0)) pump.close();
  for (const inbox of inboxes.splice(0)) inbox.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function store(): AutomationStore {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'metro-automation-')));
  roots.push(root);
  return new AutomationStore(join(root, 'automation'));
}

function fixture(saved = store()): { saved: AutomationStore; pump: Automation; inbox: Inbox; watch: SessionWatch; interrupted: string[]; errors: unknown[] } {
  const interrupted: string[] = [];
  const errors: unknown[] = [];
  const watch = new SessionWatch(() => false);
  const inbox = new Inbox(undefined, {
    ready: () => watch.admitting,
    dispatch: (message) => { pump.dispatched(message.uuid); watch.dispatched(message.uuid); },
  });
  const pump = new Automation(saved, inbox, (id) => { interrupted.push(id); }, (err) => { errors.push(err); });
  pumps.push(pump);
  inboxes.push(inbox);
  return { saved, pump, inbox, watch, interrupted, errors };
}

const result = (uuid: string, success = true): Record<string, unknown> => ({ type: 'result', user_message_uuids: [uuid], subtype: success ? 'success' : 'error_during_execution', is_error: !success });
const started = (uuid: string): Record<string, unknown> => ({ type: 'command_lifecycle', state: 'started', command_uuid: uuid });

describe('local automation dispatch', () => {
  test('durably fences before SDK yield and uses scheduled provenance without channel identity', async () => {
    const f = fixture();
    const request = f.saved.submit('hourly', Date.now(), 'Check existing approvals only.');
    f.pump.start();
    expect(f.saved.status(request.uuid)).toBeNull();
    const next = await f.inbox[Symbol.asyncIterator]().next();
    expect(next.value).toMatchObject({ uuid: request.uuid, client_composed: true, origin: { kind: 'task-notification', subkind: 'scheduled-trigger' } });
    expect(next.value.priority).toBeUndefined();
    expect(next.value.message.content).not.toContain('<channel');
    expect(next.value.message.content).toContain('not a new message from a person');
    expect(f.saved.status(request.uuid)?.state).toBe('dispatched');
    const token = f.saved.status(request.uuid)?.token ?? '';
    expect(next.value.message.content).toContain(`\n${automationShellCommand(['finish', request.uuid, token, 'completed'])}\n`);
    expect(next.value.message.content).toContain(`\n${automationShellCommand(['status', request.routine])}\n`);
    expect(next.value.message.content).not.toContain('metro task finish');
    expect(f.inbox.unanswered()).toEqual([]);
  });

  test('parent completion and unrelated receipts never finish the sweep or overlap its worker', async () => {
    const f = fixture();
    const at = Date.now();
    const first = f.saved.submit('hourly', at - 10_000, 'Check');
    f.pump.start();
    await f.inbox[Symbol.asyncIterator]().next();
    f.pump.observe({ ...started(first.uuid), parent_tool_use_id: 'worker' });
    f.pump.observe(result(randomUUID()));
    expect(f.saved.status(first.uuid)?.state).toBe('dispatched');
    f.pump.observe(started(first.uuid));
    expect(f.saved.status(first.uuid)?.state).toBe('consumed');
    f.pump.observe(result(first.uuid));
    f.watch.observe(result(first.uuid));
    expect(f.saved.status(first.uuid)?.state).toBe('awaiting-completion');
    const second = f.saved.submit('hourly', at, 'Check');
    f.pump.poll();
    expect(f.inbox.pending).toBe(0);
    const token = f.saved.status(first.uuid)!.token;
    f.saved.finish(first.uuid, token, 'completed');
    f.pump.poll();
    expect(f.saved.status(first.uuid)?.state).toBe('completed');
    expect((await f.inbox[Symbol.asyncIterator]().next()).value.uuid).toBe(second.uuid);
  });

  test('offline ticks coalesce to newest without replaying every missed hour', async () => {
    const f = fixture();
    const at = Date.now();
    const old = f.saved.submit('hourly', at - 7_200_000, 'Check');
    const middle = f.saved.submit('hourly', at - 3_600_000, 'Check');
    const latest = f.saved.submit('hourly', at, 'Check');
    f.pump.start();
    expect(f.saved.status(old.uuid)?.state).toBe('coalesced');
    expect(f.saved.status(middle.uuid)?.state).toBe('coalesced');
    expect((await f.inbox[Symbol.asyncIterator]().next()).value.uuid).toBe(latest.uuid);
    f.pump.poll();
    expect(f.inbox.pending).toBe(0);
  });

  test('a delayed older tick after completion cannot run behind the routine watermark', async () => {
    const f = fixture();
    const at = Date.now();
    const latest = f.saved.submit('hourly', at, 'Check');
    f.pump.start();
    await f.inbox[Symbol.asyncIterator]().next();
    f.saved.finish(latest.uuid, f.saved.status(latest.uuid)!.token, 'completed');
    f.pump.poll();
    const delayed = f.saved.submit('hourly', at - 3_600_000, 'Check');
    f.pump.poll();
    expect(f.saved.status(delayed.uuid)?.state).toBe('coalesced');
    expect(f.inbox.pending).toBe(0);
  });

  test('a valid near-future slot is accepted offline but never admitted early', () => {
    const f = fixture();
    const future = f.saved.submit('hourly', Date.now() + 120_000, 'Check');
    f.pump.start();
    expect(f.saved.status(future.uuid)).toBeNull();
    expect(f.inbox.pending).toBe(0);
  });

  test('restart keeps undispatched work but never replays an uncertain dispatched prompt', async () => {
    const f = fixture();
    const at = Date.now();
    const request = f.saved.submit('hourly', at - 1_000, 'Perform a side effect only once');
    f.pump.start();
    f.pump.close();
    f.inbox.close();
    const restored = fixture(f.saved);
    restored.pump.start();
    expect((await restored.inbox[Symbol.asyncIterator]().next()).value.uuid).toBe(request.uuid);
    restored.pump.close();
    restored.inbox.close();
    f.saved.submit('hourly', at, 'Check');
    const restarted = fixture(f.saved);
    restarted.pump.start();
    expect(f.saved.status(request.uuid)?.state).toBe('interrupted');
    expect(restarted.interrupted).toEqual([request.uuid]);
    expect(restarted.inbox.pending).toBe(0);
  });

  test('approval and compaction keep automation queued without a dispatch fence', async () => {
    const f = fixture();
    const request = f.saved.submit('hourly', Date.now(), 'Check');
    f.watch.observe({ type: 'system', subtype: 'session_state_changed', state: 'requires_action' });
    f.pump.start();
    let delivered = false;
    const pending = f.inbox[Symbol.asyncIterator]().next().then((item) => { delivered = true; return item; });
    await Bun.sleep(5);
    expect(delivered).toBe(false);
    expect(f.saved.status(request.uuid)).toBeNull();
    f.watch.observe({ type: 'system', subtype: 'status', status: 'compacting' });
    f.watch.observe({ type: 'system', subtype: 'session_state_changed', state: 'running' });
    f.inbox.notify();
    await Bun.sleep(5);
    expect(delivered).toBe(false);
    f.watch.observe({ type: 'system', subtype: 'compact_boundary' });
    f.inbox.notify();
    expect((await pending).value.uuid).toBe(request.uuid);
  });

  test('failed turns and blocked receipts hold future ticks until explicit verified resolution', async () => {
    const f = fixture();
    const at = Date.now();
    const request = f.saved.submit('hourly', at - 1_000, 'Check');
    f.pump.start();
    await f.inbox[Symbol.asyncIterator]().next();
    f.pump.observe(result(request.uuid, false));
    f.watch.observe(result(request.uuid, false));
    const token = f.saved.status(request.uuid)!.token;
    f.saved.finish(request.uuid, token, 'blocked');
    f.saved.submit('hourly', at, 'Check');
    f.pump.poll();
    expect(f.inbox.pending).toBe(0);
    expect(f.saved.status(request.uuid)?.state).toBe('failed');
    f.saved.finish(request.uuid, token, 'completed');
    f.pump.poll();
    expect(f.saved.status(request.uuid)?.state).toBe('completed');
    expect(f.inbox.pending).toBe(1);
  });

  test('explicit Stop cancels the active run and never starts or restarts a session', async () => {
    const f = fixture();
    const request = f.saved.submit('hourly', Date.now(), 'Check');
    f.pump.start();
    await f.inbox[Symbol.asyncIterator]().next();
    f.pump.close(true);
    expect(f.saved.status(request.uuid)?.state).toBe('cancelled');
    f.pump.poll();
    expect(f.inbox.pending).toBe(0);
  });

  test.each(['failed', 'interrupted'] as const)('Stop preserves an existing %s fence until verified completion', async (state) => {
    const f = fixture();
    const at = Date.now();
    const request = f.saved.submit('hourly', at - 1_000, 'Check');
    f.pump.start();
    await f.inbox[Symbol.asyncIterator]().next();
    const token = f.saved.status(request.uuid)!.token;
    f.saved.saveStatus({ uuid: request.uuid, token, state, updatedAt: at });
    const later = f.saved.submit('hourly', at, 'Check');
    f.pump.close(true);
    f.inbox.close();
    expect(f.saved.status(request.uuid)?.state).toBe(state);
    const restarted = fixture(f.saved);
    restarted.pump.start();
    expect(restarted.inbox.pending).toBe(0);
    expect(f.saved.status(later.uuid)).toBeNull();
    expect(f.saved.resolutions()).toEqual([]);
    f.saved.finish(request.uuid, token, 'completed');
    restarted.pump.poll();
    expect((await restarted.inbox[Symbol.asyncIterator]().next()).value.uuid).toBe(later.uuid);
  });

  test('Stop verifies an already persisted blocked receipt before cancelling active work', async () => {
    const f = fixture();
    const request = f.saved.submit('hourly', Date.now() - 1_000, 'Check');
    f.pump.start();
    await f.inbox[Symbol.asyncIterator]().next();
    f.saved.finish(request.uuid, f.saved.status(request.uuid)!.token, 'blocked');
    f.pump.close(true);
    expect(f.saved.status(request.uuid)?.state).toBe('failed');
    f.inbox.close();
    f.saved.submit('hourly', Date.now(), 'Check');
    const restarted = fixture(f.saved);
    restarted.pump.start();
    expect(restarted.inbox.pending).toBe(0);
  });

  test('Stop preserves the chat cancellation checkpoint even when automation storage fails', async () => {
    class RefusingStore extends AutomationStore {
      override resolutions(): AutomationResolution[] { throw new Error('fixture corrupt queue'); }
    }
    const saved = store();
    const root = dirname(saved.root);
    const session = new SessionStore(join(root, 'session.json'), root, root);
    const runner = new Runner({ store: session, automationStore: new RefusingStore(saved.root), readOnly: () => false });
    const active = runner.inbox.push('chat', 'already handed to SDK');
    const queued = runner.inbox.push('chat', 'not handed to SDK');
    expect((await runner.inbox[Symbol.asyncIterator]().next()).value.uuid).toBe(active);
    expect(() => runner.close(true)).toThrow('fixture corrupt queue');
    expect(session.unanswered()).toEqual([expect.objectContaining({ uuid: queued, state: 'queued' })]);
  });

  test('persistence failure prevents delivery instead of silently running without a fence', async () => {
    class RefusingStore extends AutomationStore {
      override saveStatus(_status: AutomationStatus): void { throw new Error('fixture disk failure'); }
    }
    const original = store();
    const saved = new RefusingStore(original.root);
    saved.submit('hourly', Date.now(), 'Check');
    const f = fixture(saved);
    f.pump.start();
    await expect(f.inbox[Symbol.asyncIterator]().next()).rejects.toThrow('fixture disk failure');
    expect(f.errors).toHaveLength(1);
  });
});
