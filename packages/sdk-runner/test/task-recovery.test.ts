import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { Inbox } from '../src/inbox.ts';
import { Runner, type OpenSession } from '../src/runner.ts';
import { SessionStore } from '../src/session-store.ts';
import { TaskRecovery } from '../src/task-recovery.ts';

const dirs: string[] = [];
const cleanups: (() => void)[] = [];
beforeEach(() => { jest.useFakeTimers(); });
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  jest.useRealTimers();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const started = (id = 'worker', tool = 'launch'): Record<string, unknown> => ({ type: 'system', subtype: 'task_started', task_id: id, tool_use_id: tool, task_type: 'local_agent', uuid: randomUUID() });
const ended = (id = 'worker', status = 'failed'): Record<string, unknown> => ({ type: 'system', subtype: 'task_notification', task_id: id, status, uuid: randomUUID() });
const tool = (id: string, name: string, parent: string | null = null): Record<string, unknown> => ({ type: 'assistant', parent_tool_use_id: parent, message: { content: [{ type: 'tool_use', id, name, input: {} }] } });
const consume = (id: string): Record<string, unknown> => ({ type: 'command_lifecycle', state: 'started', command_uuid: id });
const result = (id: string, error = false): Record<string, unknown> => ({ type: 'result', subtype: 'success', is_error: error, user_message_uuids: [id], uuid: randomUUID() });
const text = (value: string, parent: string | null = null): Record<string, unknown> => ({ type: 'assistant', parent_tool_use_id: parent, message: { content: [{ type: 'text', text: value }] } });
const sdk = (raw: Record<string, unknown>): SDKMessage => raw as unknown as SDKMessage;

function fixture(store?: SessionStore) {
  const dir = mkdtempSync(join(tmpdir(), 'sdk-task-recovery-'));
  dirs.push(dir);
  const path = join(dir, 'session.json');
  store ??= new SessionStore(path, join(dir, 'claude'), dir);
  const inbox = new Inbox();
  const recovered = store.recover();
  let now = Date.now();
  const errors: unknown[] = [];
  const recovery = new TaskRecovery(store, inbox, recovered.tasks, recovered.interrupted, (err) => { errors.push(err); }, () => now);
  cleanups.push(() => { recovery.close(false); inbox.close(); });
  const advance = (ms = 0): void => { now += ms; jest.advanceTimersByTime(ms); };
  recovery.start();
  return { recovery, store, path, inbox, advance, errors, read: inbox[Symbol.asyncIterator]() };
}

async function nextNotice(f: ReturnType<typeof fixture>) {
  f.advance();
  expect(f.inbox.pending).toBeGreaterThan(0);
  const message = (await f.read.next()).value;
  if (message?.uuid === undefined) throw new Error('fixture notice missing');
  return { uuid: message.uuid, text: String(message.message.content) };
}

const acknowledgment = (f: ReturnType<typeof fixture>): string => {
  const token = f.recovery.ledger.snapshot().find((task) => task.notice !== null)?.notice?.token;
  if (token === undefined) throw new Error('fixture token missing');
  return `[metro-task-handled:${token}]`;
};

describe('durable worker recovery', () => {
  test('main completion followed by a child crash retains its owner and alerts the resumed main, without replaying work', async () => {
    const f = fixture();
    const input = randomUUID();
    const open: OpenSession = () => ({
      async *[Symbol.asyncIterator]() {
        yield sdk(consume(input));
        yield sdk(tool('launch', 'Agent'));
        yield sdk(started());
        yield sdk(result(input));
        throw new Error('fixture crash');
      },
      applyFlagSettings: () => Promise.resolve(), close: () => undefined,
    }) as ReturnType<OpenSession>;
    const runner = new Runner({ store: f.store, open, readOnly: () => false });
    runner.inbox.push('chat', 'original edit and send request', undefined, input);
    runner.start({});
    await expect(runner.run()).rejects.toThrow('fixture crash');
    runner.close(false);
    expect(f.store.unanswered()).toEqual([]);
    const resumed = fixture(f.store);
    const notice = await nextNotice(resumed);
    expect(notice.text).toContain('Task worker, owner main, attempt 1, state interrupted');
    expect(notice.text).not.toContain('original edit and send request');
    expect(resumed.store.recover().tasks[0]?.notice).not.toBeNull();
    expect(statSync(f.path).mode & 0o777).toBe(0o600);
  });

  test('queueing, consuming, worker text and unrelated successful results never acknowledge a failure', async () => {
    const f = fixture();
    f.recovery.observe(started());
    f.recovery.observe(ended());
    const notice = await nextNotice(f);
    const ack = acknowledgment(f);
    f.recovery.observe(text(ack));
    f.recovery.observe(consume(notice.uuid));
    f.recovery.observe(text(ack, 'launch'));
    f.recovery.observe(result(randomUUID()));
    expect(f.store.recover().tasks[0]?.notice).not.toBeNull();
    f.recovery.observe(result(notice.uuid));
    expect(f.store.recover().tasks[0]?.notice).not.toBeNull();
  });

  test('only explicit main acknowledgment followed by correlated success settles the persisted obligation', async () => {
    const f = fixture();
    f.recovery.observe(started());
    f.recovery.observe(ended());
    const notice = await nextNotice(f);
    f.recovery.observe(consume(notice.uuid));
    f.recovery.observe(text(acknowledgment(f)));
    expect(f.store.recover().tasks[0]?.notice).not.toBeNull();
    f.recovery.observe(result(notice.uuid));
    expect(f.store.recover().tasks[0]?.notice).toBeNull();
    const resumed = fixture(f.store);
    resumed.advance();
    expect(resumed.inbox.pending).toBe(0);
  });

  test('a failed acknowledgment turn stays pending and reminder retries are bounded, without replaying actions', async () => {
    const f = fixture();
    f.recovery.observe(started());
    f.recovery.observe({ ...ended(), summary: 'API Error 429: rate limit' });
    f.advance(29_999);
    expect(f.inbox.pending).toBe(0);
    f.advance(1);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const notice = await nextNotice(f);
      f.recovery.observe(consume(notice.uuid));
      f.recovery.observe(text(acknowledgment(f)));
      f.recovery.observe(result(notice.uuid, true));
      expect(f.store.recover().tasks).toHaveLength(1);
      f.advance(attempt === 0 ? 30_000 : 120_000);
    }
    f.advance(600_000);
    expect(f.inbox.pending).toBe(0);
    expect(f.store.recover().tasks[0]?.notice).toMatchObject({ reason: 'rate_limit', deliveries: 3 });
  });

  test('a nested relay resume receipt revives the original owner and increments its attempt once', () => {
    const f = fixture();
    const launch = started();
    f.recovery.observe(tool('launch', 'Agent'));
    f.recovery.observe(launch);
    f.recovery.observe(ended('worker', 'completed'));
    f.recovery.observe(tool('relay-resume', 'SendMessage', 'relay-launch'));
    const receipt = { type: 'user', parent_tool_use_id: 'relay-launch', message: { content: [{ type: 'tool_result', tool_use_id: 'relay-resume', content: JSON.stringify({ success: true, resumedAgentId: 'worker' }) }] } };
    f.recovery.observe(receipt);
    f.recovery.observe(started());
    f.recovery.observe(launch);
    expect(f.recovery.ledger.snapshot()[0]).toMatchObject({ id: 'worker', owner: 'main', state: 'running', attempt: 2 });
    expect(f.store.recover().tasks[0]).toMatchObject({ owner: 'main', state: 'interrupted', attempt: 2 });
    f.recovery.observe(ended('worker', 'completed'));
    f.recovery.observe(receipt);
    expect(f.recovery.ledger.snapshot()[0]).toMatchObject({ state: 'completed', attempt: 2 });
  });

  test('child Bash ownership comes from its tool parent, and worker_restart is not cancellation', async () => {
    const f = fixture();
    f.recovery.observe(tool('launch', 'Agent'));
    f.recovery.observe(started());
    f.recovery.observe(tool('bash', 'Bash', 'launch'));
    f.recovery.observe(started('shell', 'bash'));
    f.recovery.observe({ ...ended('shell', 'stopped'), reason: 'worker_restart' });
    const notice = await nextNotice(f);
    expect(notice.text).toContain('Task shell, owner worker');
    expect(notice.text).toContain('reason worker_restart');
    expect(f.store.recover().tasks.find((task) => task.id === 'shell')?.state).toBe('interrupted');
  });

  test('explicit cancellation clears worker obligations, preserving shutdown does not', () => {
    for (const cancel of [false, true]) {
      const f = fixture();
      f.recovery.observe(started());
      f.recovery.close(cancel);
      const task = f.store.recover().tasks[0];
      expect(task?.state).toBe(cancel ? 'stopped' : 'interrupted');
      expect(task?.notice === null).toBe(cancel);
    }
  });

  test('interrupted input is a safe obligation rather than an executable prompt and clears only on acknowledgment', async () => {
    const f = fixture();
    f.store.saveUnanswered([{ uuid: randomUUID(), text: 'private original send request', at: 1, state: 'started' }]);
    const resumed = fixture(f.store);
    const notice = await nextNotice(resumed);
    expect(notice.text).not.toContain('private original send request');
    resumed.recovery.observe(consume(notice.uuid));
    resumed.recovery.observe(text(acknowledgment(resumed)));
    resumed.recovery.observe(result(notice.uuid));
    expect(f.store.recover().interrupted).toEqual([]);
  });

  test('terminal main provider failure becomes one delayed recovery obligation', async () => {
    const f = fixture();
    f.recovery.observe({ ...result(randomUUID(), true), api_error_status: 429 });
    f.advance(30_000);
    expect((await nextNotice(f)).text).toContain('reason rate_limit');
    expect(f.store.recover().tasks).toHaveLength(1);
  });

  test('a failed mixed chat and recovery turn keeps its separate main failure', async () => {
    const f = fixture();
    f.recovery.observe(ended());
    const notice = await nextNotice(f);
    const chat = randomUUID();
    f.recovery.observe(consume(notice.uuid));
    f.recovery.observe(consume(chat));
    f.recovery.observe({ ...result(chat, true), user_message_uuids: [notice.uuid, chat] });
    expect(f.recovery.ledger.snapshot()).toHaveLength(2);
    expect(f.recovery.ledger.snapshot().some((task) => task.id.startsWith('turn:'))).toBe(true);
  });

  test('an unrelated result cannot settle a main acknowledgment from another turn', async () => {
    const f = fixture();
    f.recovery.observe(ended());
    const notice = await nextNotice(f);
    f.recovery.observe(consume(notice.uuid));
    f.recovery.observe(text(acknowledgment(f)));
    f.recovery.observe(result(randomUUID()));
    expect(f.recovery.ledger.snapshot()[0]?.notice).not.toBeNull();
  });

  test('a new attempt failure cannot be cleared by an earlier attempt acknowledgment', async () => {
    const f = fixture();
    f.recovery.observe(started());
    f.recovery.observe(ended());
    const notice = await nextNotice(f);
    const old = acknowledgment(f);
    f.recovery.observe(consume(notice.uuid));
    f.recovery.observe(started());
    f.recovery.observe(ended());
    f.recovery.observe(text(old));
    f.recovery.observe(result(notice.uuid));
    expect(f.recovery.ledger.snapshot()[0]?.notice).toMatchObject({ attempt: 2 });
    expect(acknowledgment(f)).not.toBe(old);
  });

  test('a full pending ledger can recover before adding saved interrupted inputs', async () => {
    const f = fixture();
    for (let i = 0; i < 200; i += 1) f.recovery.observe(ended(`worker-${i}`));
    f.store.saveUnanswered([{ uuid: randomUUID(), text: 'private backlog', at: 1, state: 'started' }]);
    f.recovery.close(false);
    const resumed = fixture(f.store);
    const notice = await nextNotice(resumed);
    resumed.recovery.observe(consume(notice.uuid));
    resumed.recovery.observe(text(acknowledgment(resumed)));
    resumed.recovery.observe(result(notice.uuid));
    expect(resumed.recovery.ledger.snapshot()).toHaveLength(200);
    expect(resumed.recovery.ledger.snapshot().some((task) => task.id.startsWith('input:'))).toBe(true);
    expect(resumed.store.recover().interrupted).toHaveLength(1);
  });

  test('the reminder budget survives restart and a later main turn can explicitly acknowledge', async () => {
    const f = fixture();
    f.recovery.observe(ended());
    for (let i = 0; i < 3; i += 1) {
      const notice = await nextNotice(f);
      f.recovery.observe(consume(notice.uuid));
      f.recovery.observe(result(notice.uuid, true));
      f.advance(300_000);
    }
    const ack = acknowledgment(f);
    f.recovery.close(false);
    const resumed = fixture(f.store);
    resumed.advance(600_000);
    expect(resumed.inbox.pending).toBe(0);
    const later = randomUUID();
    resumed.recovery.observe(consume(later));
    resumed.recovery.observe(text(ack));
    resumed.recovery.observe(result(later));
    expect(resumed.recovery.ledger.snapshot()[0]?.notice).toBeNull();
  });

  test('ordinary task stop is not an error, while an orphaned task is pending', () => {
    const f = fixture();
    f.recovery.observe(started());
    f.recovery.observe(ended('worker', 'stopped'));
    expect(f.recovery.ledger.snapshot()[0]?.notice).toBeNull();
    f.recovery.observe({ ...ended('worker', 'stopped'), reason: 'worker_restart' });
    expect(f.recovery.ledger.snapshot()[0]?.notice?.reason).toBe('worker_restart');
  });

  test('terminal patches and later ambient inventory cannot leave a phantom unfinished task', () => {
    const f = fixture();
    f.recovery.observe(started());
    f.recovery.observe({ type: 'system', subtype: 'task_updated', task_id: 'worker', patch: { status: 'completed' }, uuid: randomUUID() });
    expect(f.store.recover().tasks[0]?.state).toBe('completed');
    f.recovery.observe(started('watcher'));
    f.recovery.observe({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'watcher', ambient: true }] });
    expect(f.store.recover().tasks.some((task) => task.id === 'watcher')).toBe(false);
  });

  test('late owner correlation resolves to the worker id, not its tool-use id', () => {
    const f = fixture();
    f.recovery.observe(started('shell', 'bash'));
    f.recovery.observe(tool('bash', 'Bash', 'launch'));
    f.recovery.observe(started());
    f.recovery.observe(tool('launch', 'Agent'));
    expect(f.recovery.ledger.snapshot().find((task) => task.id === 'shell')?.owner).toBe('worker');
    expect(f.recovery.ledger.snapshot().find((task) => task.id === 'worker')?.owner).toBe('main');
  });

  test('aborted assistant text cannot acknowledge and late explicit Stop clears after preservation', async () => {
    const f = fixture();
    f.recovery.observe(ended());
    const notice = await nextNotice(f);
    f.recovery.observe(consume(notice.uuid));
    f.recovery.observe({ ...text(acknowledgment(f)), aborted: true });
    f.recovery.observe(result(notice.uuid));
    expect(f.recovery.ledger.snapshot()[0]?.notice).not.toBeNull();
    f.recovery.close(false);
    f.recovery.close(true);
    expect(f.store.recover().tasks[0]?.notice).toBeNull();
  });

  test('malformed saved tasks fail closed and do not overwrite state', () => {
    const f = fixture();
    const raw = JSON.stringify({ tasks: [{ id: 'worker', state: 'running' }] });
    writeFileSync(f.path, raw);
    expect(() => f.store.recover()).toThrow('saved Agent SDK state');
    expect(readFileSync(f.path, 'utf8')).toBe(raw);
  });

  test('failed persistence prevents a recovery notice from executing', () => {
    const f = fixture();
    f.recovery.observe(started());
    f.recovery.observe(ended());
    writeFileSync(f.path, 'broken');
    f.advance();
    expect(f.errors).toHaveLength(1);
    expect(f.inbox.pending).toBe(0);
    expect(readFileSync(f.path, 'utf8')).toBe('broken');
  });
});
