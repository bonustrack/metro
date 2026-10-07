import { afterEach, beforeEach, expect, jest, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Inbox } from '../src/inbox.ts';
import { SessionStore } from '../src/session-store.ts';
import { TaskRecovery } from '../src/task-recovery.ts';

const cleanups: (() => void)[] = [];
beforeEach(() => { jest.useFakeTimers(); });
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  jest.useRealTimers();
});
const started = (tool: string | undefined = 'launch') => ({ type: 'system', subtype: 'task_started', task_id: 'worker', tool_use_id: tool, uuid: randomUUID() });
const ended = (status = 'failed') => ({ type: 'system', subtype: 'task_notification', task_id: 'worker', status, uuid: randomUUID() });
const consume = (id: string) => ({ type: 'command_lifecycle', state: 'started', command_uuid: id });
const result = (id: string, error = false) => ({ type: 'result', subtype: 'success', is_error: error, user_message_uuids: [id], uuid: randomUUID() });
const tool = (id: string, name: string) => ({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id, name, input: {} }] } });

function fixture(store?: SessionStore) {
  const dir = mkdtempSync(join(tmpdir(), 'sdk-recovery-edges-'));
  cleanups.push(() => { rmSync(dir, { recursive: true, force: true }); });
  store ??= new SessionStore(join(dir, 'session.json'), join(dir, 'claude'), dir);
  const inbox = new Inbox();
  const saved = store.recover();
  const errors: unknown[] = [];
  let now = Date.now();
  const recovery = new TaskRecovery(store, inbox, saved.tasks, saved.interrupted, (err) => { errors.push(err); }, () => now);
  cleanups.push(() => { recovery.close(false); inbox.close(); });
  const advance = (ms = 0): void => { now += ms; jest.advanceTimersByTime(ms); };
  const read = inbox[Symbol.asyncIterator]();
  const next = async () => {
    advance();
    expect(inbox.pending).toBeGreaterThan(0);
    const value = (await read.next()).value;
    if (value?.uuid === undefined) throw new Error('missing fixture notice');
    return value.uuid;
  };
  const ack = (ids?: string[]) => ({ type: 'assistant', parent_tool_use_id: null, ...(ids === undefined ? {} : { user_message_uuids: ids }), message: { content: [{ type: 'text', text: `[metro-task-handled:${recovery.ledger.snapshot()[0]?.notice?.token}]` }] } });
  recovery.start();
  return { recovery, store, inbox, errors, advance, next, ack };
}

test('a held earlier result cannot settle a stamped acknowledgment from a later turn', async () => {
  const f = fixture();
  const earlier = randomUUID();
  f.recovery.observe(consume(earlier));
  f.recovery.observe(ended());
  const notice = await f.next();
  f.recovery.observe(consume(notice));
  f.recovery.observe(f.ack([notice]));
  f.recovery.observe(result(earlier));
  expect(f.recovery.ledger.snapshot()[0]?.notice).not.toBeNull();
  f.recovery.observe(result(notice, true));
  expect(f.recovery.ledger.snapshot()[0]?.notice).not.toBeNull();
});

test('an unrelated result does not discard a valid acknowledgment waiting for its result', async () => {
  const f = fixture();
  f.recovery.observe(ended());
  const notice = await f.next();
  f.recovery.observe(consume(notice));
  f.recovery.observe(f.ack([notice]));
  f.recovery.observe(result(randomUUID()));
  expect(f.recovery.ledger.snapshot()[0]?.notice).not.toBeNull();
  f.recovery.observe(result(notice));
  expect(f.recovery.ledger.snapshot()[0]?.notice).toBeNull();
});

test('an unstamped acknowledgment is ambiguous when multiple consumed inputs await results', async () => {
  const f = fixture();
  const earlier = randomUUID();
  f.recovery.observe(consume(earlier));
  f.recovery.observe(ended());
  const notice = await f.next();
  f.recovery.observe(consume(notice));
  f.recovery.observe(f.ack());
  f.recovery.observe(result(earlier));
  f.recovery.observe(result(notice));
  expect(f.recovery.ledger.snapshot()[0]?.notice).not.toBeNull();
});

test('later unstamped assistant output retains its actual stamped turn when a recovery note folds in', async () => {
  const f = fixture();
  const chat = randomUUID();
  f.recovery.observe(consume(chat));
  f.recovery.observe({ ...tool('read', 'Read'), user_message_uuids: [chat] });
  f.recovery.observe(ended());
  const notice = await f.next();
  f.recovery.observe(consume(notice));
  f.recovery.observe(f.ack());
  f.recovery.observe({ type: 'command_lifecycle', state: 'completed', command_uuid: chat });
  f.recovery.observe({ ...result(chat), user_message_uuids: [chat, notice] });
  expect(f.recovery.ledger.snapshot()[0]?.notice).toBeNull();
});

test('a completed turn cannot lend its old stamp to an unstamped assistant on another turn', async () => {
  const f = fixture();
  const chat = randomUUID();
  f.recovery.observe(consume(chat));
  f.recovery.observe({ ...tool('read', 'Read'), user_message_uuids: [chat] });
  f.recovery.observe(ended());
  const notice = await f.next();
  f.recovery.observe(consume(notice));
  f.recovery.observe({ type: 'command_lifecycle', state: 'completed', command_uuid: chat });
  f.recovery.observe(f.ack());
  f.recovery.observe(result(chat));
  expect(f.recovery.ledger.snapshot()[0]?.notice).not.toBeNull();
});

test('a first stream stamp survives unrelated held results and child stamps until main acknowledgment', async () => {
  const f = fixture();
  f.recovery.observe(ended());
  const notice = await f.next();
  f.recovery.observe({ type: 'system', subtype: 'init' });
  f.recovery.observe(consume(notice));
  f.recovery.observe({ type: 'stream_event', parent_tool_use_id: null, user_message_uuid: notice });
  f.recovery.observe(result(randomUUID()));
  f.recovery.observe({ ...tool('child', 'Read'), parent_tool_use_id: 'launch', user_message_uuids: [randomUUID()] });
  f.recovery.observe(f.ack());
  f.recovery.observe(result(notice));
  expect(f.recovery.ledger.snapshot()[0]?.notice).toBeNull();
});

for (const boundary of [{ type: 'system', subtype: 'init' }, { type: 'system', subtype: 'session_state_changed', state: 'idle' }]) test(`${boundary.subtype} retires old reply stamps without inventing a singleton turn`, async () => {
  const f = fixture();
  f.recovery.observe(ended());
  const notice = await f.next();
  f.recovery.observe(consume(notice));
  f.recovery.observe({ ...tool('read', 'Read'), user_message_uuids: [notice] });
  f.recovery.observe(boundary);
  f.recovery.observe(f.ack());
  f.recovery.observe(result(notice));
  expect(f.recovery.ledger.snapshot()[0]?.notice).not.toBeNull();
});

test('unconsumed notices survive repeated preserving restarts without spending their delivery budget', async () => {
  let f = fixture();
  f.recovery.observe(ended());
  let offered: string | undefined;
  for (let index = 0; index < 4; index += 1) {
    f.advance(300_000);
    const id = await f.next();
    offered ??= id;
    expect(id).toBe(offered);
    expect(f.recovery.ledger.snapshot()[0]?.notice?.deliveries).toBe(0);
    f.recovery.close(false);
    f = fixture(f.store);
  }
  const id = await f.next();
  f.recovery.observe(consume(id));
  expect(f.recovery.ledger.snapshot()[0]?.notice?.deliveries).toBe(1);
  f.recovery.observe(f.ack([id]));
  f.recovery.observe(result(id));
  expect(f.recovery.ledger.snapshot()[0]?.notice).toBeNull();
});

test('a replayed notice UUID with completed-only receipt counts once and permits the next bounded reminder', async () => {
  const f = fixture();
  f.recovery.observe(ended());
  const original = await f.next();
  f.recovery.close(false);
  const resumed = fixture(f.store);
  expect(await resumed.next()).toBe(original);
  const completed = { type: 'command_lifecycle', state: 'completed', command_uuid: original };
  resumed.recovery.observe(completed);
  resumed.recovery.observe(completed);
  expect(resumed.recovery.ledger.snapshot()[0]?.notice).toMatchObject({ consumed: true, deliveries: 1 });
  resumed.advance(30_000);
  const reminder = await resumed.next();
  expect(reminder).not.toBe(original);
  resumed.recovery.observe(consume(reminder));
  resumed.recovery.observe(consume(reminder));
  expect(resumed.recovery.ledger.snapshot()[0]?.notice?.deliveries).toBe(2);
  resumed.recovery.observe(resumed.ack([reminder]));
  resumed.recovery.observe(result(reminder));
  expect(resumed.recovery.ledger.snapshot()[0]?.notice).toBeNull();
});

test('a successful receipt alone never acknowledges a notice even when the started event was missed', async () => {
  const f = fixture();
  f.recovery.observe(ended());
  const notice = await f.next();
  f.recovery.observe(result(notice));
  expect(f.recovery.ledger.snapshot()[0]?.notice).toMatchObject({ deliveries: 1, consumed: true });
  f.advance(30_000);
  expect(await f.next()).not.toBe(notice);
});

test('completed recovery-only inputs keep delayed failed results inside their original reminder budget', async () => {
  const f = fixture();
  f.recovery.observe(ended());
  const first = await f.next();
  f.recovery.observe(consume(first));
  f.recovery.observe({ ...ended(), task_id: 'other' });
  const folded = await f.next();
  f.recovery.observe(consume(folded));
  f.recovery.observe({ type: 'command_lifecycle', state: 'completed', command_uuid: folded });
  f.recovery.observe({ ...result(first, true), user_message_uuids: [first, folded] });
  expect(f.recovery.ledger.snapshot().map((task) => task.id)).toEqual(['worker', 'other']);
  f.advance(30_000);
  const next = await f.next();
  f.recovery.observe(consume(next));
  f.recovery.observe({ type: 'command_lifecycle', state: 'completed', command_uuid: next });
  f.recovery.observe(result(next, true));
  expect(f.recovery.ledger.snapshot().map((task) => task.id)).toEqual(['worker', 'other']);
});

for (const saturation of ['note lane', 'shared bytes']) test(`${saturation} saturation defers recovery without shutting down or spending a delivery`, async () => {
  const f = fixture();
  const kind = saturation === 'note lane' ? 'note' : 'call';
  const value = saturation === 'note lane' ? 'queued' : 'x'.repeat(256 * 1024);
  for (let index = 0; index < 16; index += 1) f.inbox.push(kind, value);
  f.recovery.observe(ended());
  f.advance();
  expect(f.errors).toEqual([]);
  expect(f.recovery.ledger.snapshot()[0]?.notice?.deliveries).toBe(0);
  const read = f.inbox[Symbol.asyncIterator]();
  for (let index = 0; index < 16; index += 1) await read.next();
  f.advance(30_000);
  const notice = await f.next();
  f.recovery.observe(consume(notice));
  f.recovery.observe(f.ack([notice]));
  f.recovery.observe(result(notice));
  expect(f.recovery.ledger.snapshot()[0]?.notice).toBeNull();
});

test('a handled failed patch cannot reopen on a later terminal notification, including after restart', async () => {
  const f = fixture();
  f.recovery.observe(started());
  f.recovery.observe({ type: 'system', subtype: 'task_updated', task_id: 'worker', patch: { status: 'failed' }, uuid: randomUUID() });
  const notice = await f.next();
  f.recovery.observe(consume(notice));
  f.recovery.observe(f.ack([notice]));
  f.recovery.observe(result(notice));
  f.recovery.close(false);
  const resumed = fixture(f.store);
  resumed.recovery.observe(ended());
  expect(resumed.recovery.ledger.snapshot()[0]?.notice).toBeNull();
  resumed.recovery.observe(started());
  resumed.recovery.observe(ended());
  expect(resumed.recovery.ledger.snapshot()[0]?.notice?.attempt).toBe(2);
});

test('a resume receipt first seen while running stays deduplicated after completion and restart', () => {
  const f = fixture();
  f.recovery.observe(tool('launch', 'Agent'));
  f.recovery.observe(started());
  f.recovery.observe(ended('completed'));
  f.recovery.observe(started());
  f.recovery.observe(tool('resume', 'SendMessage'));
  const receipt = { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'resume', content: JSON.stringify({ success: true, resumedAgentId: 'worker' }) }] } };
  f.recovery.observe(receipt);
  f.recovery.observe(ended('completed'));
  f.recovery.close(false);
  const resumed = fixture(f.store);
  resumed.recovery.observe(tool('resume', 'SendMessage'));
  resumed.recovery.observe(receipt);
  expect(resumed.recovery.ledger.snapshot()[0]).toMatchObject({ state: 'completed', attempt: 2 });
});

test('progress correlation persists the launch owner even inside the timestamp throttle', () => {
  const f = fixture();
  f.recovery.observe(tool('launch', 'Agent'));
  f.recovery.observe({ ...started(), tool_use_id: undefined });
  f.recovery.observe({ type: 'system', subtype: 'task_progress', task_id: 'worker', tool_use_id: 'launch', uuid: randomUUID() });
  f.recovery.close(false);
  expect(f.store.recover().tasks[0]).toMatchObject({ toolUseId: 'launch', owner: 'main', state: 'interrupted' });
});
