import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { CallRoute } from '@metro-labs/core/call';
import { COMPACT_IDLE_MS, Runner, type OpenSession } from '../src/runner.ts';
import { SessionStore } from '../src/session-store.ts';

const dirs: string[] = [];
const runners: Runner[] = [];
beforeEach(() => { jest.useFakeTimers(); });
afterEach(() => {
  for (const runner of runners.splice(0)) runner.close();
  jest.useRealTimers();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const msg = (value: Record<string, unknown>): SDKMessage => value as unknown as SDKMessage;
const usage = (context: number): SDKMessage => msg({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start', message: { usage: { input_tokens: context } } } });
const result = (uuids?: string[]): SDKMessage => msg({ type: 'result', subtype: 'success', ...(uuids === undefined ? {} : { user_message_uuids: uuids }) });
const route: CallRoute = { agentId: 'agent', line: 'metro://xmtp/a/chat', from: 'metro://xmtp/a/user/caller', callId: 'call', generation: 'g' };

function fixture(events: () => AsyncGenerator<SDKMessage>, context = 0): { runner: Runner; store: SessionStore; reads: () => AsyncIterator<SDKUserMessage>; closed: () => number } {
  const dir = mkdtempSync(join(tmpdir(), 'sdk-compact-test-'));
  dirs.push(dir);
  const store = new SessionStore(join(dir, 'session.json'), join(dir, 'claude'), dir);
  store.saveContext(context);
  let prompt: AsyncIterable<SDKUserMessage> | undefined;
  let closed = 0;
  const open: OpenSession = (params) => {
    prompt = params.prompt;
    return { [Symbol.asyncIterator]: events, applyFlagSettings: () => Promise.resolve(), close: () => { closed += 1; } } as ReturnType<OpenSession>;
  };
  const runner = new Runner({ store, open, readOnly: () => false });
  runners.push(runner);
  const reads = (): AsyncIterator<SDKUserMessage> => {
    if (prompt === undefined) throw new Error('runner not started');
    return prompt[Symbol.asyncIterator]();
  };
  return { runner, store, reads, closed: () => closed };
}

describe('idle compaction headroom', () => {
  test('the first high context sample waits for a quiet minute before compacting', async () => {
    const { runner, reads, store } = fixture(async function* () {
      yield usage(150_000);
      yield result();
      jest.advanceTimersByTime(COMPACT_IDLE_MS - 1);
      expect(runner.inbox.pending).toBe(0);
      jest.advanceTimersByTime(1);
    });
    runner.start({});
    await runner.run();
    expect((await reads().next()).value?.message.content).toBe('/compact');
    expect(store.recover().context).toBe(150_000);
    runner.close();
  });

  test('a saved high-context resume compacts before pending chat without changing its uuid or consumed state', async () => {
    const { runner, reads, store } = fixture(async function* () { yield result(compact?.uuid === undefined ? [] : [compact.uuid]); }, 150_000);
    const id = runner.chat({ content: 'queued', meta: {} });
    runner.start({ resume: randomUUID() });
    const read = reads();
    const compact = (await read.next()).value;
    expect(compact?.message.content).toBe('/compact');
    expect(compact?.priority).toBeUndefined();
    expect(store.unanswered()).toEqual([expect.objectContaining({ uuid: id, state: 'queued' })]);
    await runner.run();
    expect((await read.next()).value?.uuid).toBe(id);
    runner.close();
  });

  test('a correlated compact completion permits another compact after measured context growth', async () => {
    let read: AsyncIterator<SDKUserMessage>;
    const { runner, reads } = fixture(async function* () {
      yield usage(150_000);
      yield result();
      jest.advanceTimersByTime(COMPACT_IDLE_MS);
      const compact = (await read.next()).value;
      expect(compact?.message.content).toBe('/compact');
      yield msg({ type: 'command_lifecycle', state: 'started', command_uuid: compact?.uuid });
      yield msg({ type: 'system', subtype: 'status', status: 'compacting' });
      yield msg({ type: 'system', subtype: 'compact_boundary' });
      yield result(compact?.uuid === undefined ? [] : [compact.uuid]);
      yield usage(10_000);
      yield result();
      jest.advanceTimersByTime(COMPACT_IDLE_MS);
      expect(runner.inbox.pending).toBe(0);
      yield usage(160_000);
      yield result();
      jest.advanceTimersByTime(COMPACT_IDLE_MS);
    });
    runner.start({});
    read = reads();
    await runner.run();
    expect((await read.next()).value?.message.content).toBe('/compact');
    runner.close();
  });

  test('new conversations do not compact because an old transcript checkpoint was high', async () => {
    const { runner, reads } = fixture(async function* () { yield result(); }, 150_000);
    const id = runner.chat({ content: 'new chat', meta: {} });
    runner.start({});
    expect((await reads().next()).value?.uuid).toBe(id);
    expect(runner.inbox.pending).toBe(0);
    runner.close();
  });

  test('queued chat or an active call defers preventive compaction', async () => {
    const first = fixture(async function* () { yield usage(150_000); yield result(); });
    first.runner.start({});
    const id = first.runner.chat({ content: 'answer first', meta: {} });
    await first.runner.run();
    expect((await first.reads().next()).value?.uuid).toBe(id);
    expect(first.runner.inbox.pending).toBe(0);
    first.runner.close();
    const second = fixture(async function* () { yield usage(150_000); yield result(); });
    second.runner.start({});
    second.runner.calls.notice({ type: 'started', route, sourceId: 'greet' });
    await second.runner.run();
    expect((await second.reads().next()).value?.message.content).toContain('<call');
    expect(second.runner.inbox.pending).toBe(0);
    second.runner.close();
  });

  test('chat arriving after the high-context turn cancels maintenance and keeps its exact ledger', async () => {
    const { runner, reads, store } = fixture(async function* () {
      yield usage(120_261);
      yield result();
      jest.advanceTimersByTime(16_000);
      const id = runner.chat({ content: 'attachment arrived', meta: {} });
      expect((await reads().next()).value?.uuid).toBe(id);
      expect(store.unanswered()).toEqual([expect.objectContaining({ uuid: id, state: 'queued' })]);
      yield msg({ type: 'system', subtype: 'session_state_changed', state: 'idle' });
      yield msg({ type: 'result', subtype: 'success', parent_tool_use_id: 'worker', user_message_uuids: [id] });
      jest.advanceTimersByTime(COMPACT_IDLE_MS);
      expect(runner.inbox.pending).toBe(0);
      yield msg({ type: 'command_lifecycle', state: 'started', command_uuid: id });
      expect(store.unanswered()).toEqual([expect.objectContaining({ uuid: id, state: 'started' })]);
      yield result([id]);
      expect(store.unanswered()).toEqual([]);
      yield msg({ type: 'system', subtype: 'session_state_changed', state: 'idle' });
      jest.advanceTimersByTime(COMPACT_IDLE_MS - 1);
      expect(runner.inbox.pending).toBe(0);
      jest.advanceTimersByTime(1);
      expect(runner.inbox.pending).toBe(1);
    });
    runner.start({});
    await runner.run();
    runner.close();
  });

  test('running workers defer maintenance and completion leaves a full quiet handoff', async () => {
    const { runner, reads } = fixture(async function* () {
      yield msg({ type: 'system', subtype: 'task_started', task_id: 'worker', is_backgrounded: true });
      yield usage(150_000);
      yield result();
      jest.advanceTimersByTime(COMPACT_IDLE_MS * 2);
      expect(runner.inbox.pending).toBe(0);
      yield msg({ type: 'system', subtype: 'task_progress', task_id: 'worker', usage: { tool_uses: 1, duration_ms: 120_000 } });
      yield msg({ type: 'system', subtype: 'task_notification', task_id: 'worker', status: 'completed' });
      jest.advanceTimersByTime(COMPACT_IDLE_MS - 1);
      expect(runner.inbox.pending).toBe(0);
      yield usage(151_000);
      jest.advanceTimersByTime(COMPACT_IDLE_MS);
      expect(runner.inbox.pending).toBe(0);
      yield result();
      jest.advanceTimersByTime(COMPACT_IDLE_MS);
    });
    runner.start({});
    await runner.run();
    expect((await reads().next()).value?.message.content).toBe('/compact');
    runner.close();
  });

  test('a worker appearing during the quiet window cancels it until the worker ends', async () => {
    const { runner } = fixture(async function* () {
      yield usage(150_000);
      yield result();
      jest.advanceTimersByTime(COMPACT_IDLE_MS - 1);
      yield msg({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'worker', task_type: 'local_agent' }] });
      jest.advanceTimersByTime(COMPACT_IDLE_MS);
      expect(runner.inbox.pending).toBe(0);
      yield msg({ type: 'system', subtype: 'task_updated', task_id: 'worker', patch: { status: 'paused' } });
      jest.advanceTimersByTime(COMPACT_IDLE_MS);
      expect(runner.inbox.pending).toBe(0);
      yield msg({ type: 'system', subtype: 'task_updated', task_id: 'worker', patch: { status: 'killed' } });
      jest.advanceTimersByTime(COMPACT_IDLE_MS - 1);
      expect(runner.inbox.pending).toBe(0);
      jest.advanceTimersByTime(1);
      expect(runner.inbox.pending).toBe(1);
    });
    runner.start({});
    await runner.run();
    runner.close();
  });

  test.each(['running', 'requires_action'])('main state %s cancels a scheduled compact', async (state) => {
    const { runner } = fixture(async function* () {
      yield usage(150_000);
      yield result();
      jest.advanceTimersByTime(COMPACT_IDLE_MS - 1);
      yield msg({ type: 'system', subtype: 'session_state_changed', state });
      jest.advanceTimersByTime(COMPACT_IDLE_MS);
      expect(runner.inbox.pending).toBe(0);
      yield msg({ type: 'system', subtype: 'session_state_changed', state: 'idle' });
      jest.advanceTimersByTime(COMPACT_IDLE_MS);
      expect(runner.inbox.pending).toBe(1);
    });
    runner.start({});
    await runner.run();
    runner.close();
  });

  test('SDK compaction cancels scheduled maintenance and resets its context checkpoint', async () => {
    const { runner } = fixture(async function* () {
      yield usage(150_000);
      yield result();
      jest.advanceTimersByTime(COMPACT_IDLE_MS - 1);
      yield msg({ type: 'system', subtype: 'status', status: 'compacting' });
      jest.advanceTimersByTime(COMPACT_IDLE_MS);
      expect(runner.inbox.pending).toBe(0);
      yield msg({ type: 'system', subtype: 'compact_boundary' });
      yield result();
      jest.advanceTimersByTime(COMPACT_IDLE_MS);
      expect(runner.inbox.pending).toBe(0);
    });
    runner.start({});
    await runner.run();
    runner.close();
  });

  test('ambient background tasks do not keep an otherwise idle session from compacting', async () => {
    const { runner } = fixture(async function* () {
      yield msg({ type: 'system', subtype: 'task_started', task_id: 'ambient', ambient: true });
      yield usage(150_000);
      yield result();
      jest.advanceTimersByTime(COMPACT_IDLE_MS);
      expect(runner.inbox.pending).toBe(1);
    });
    runner.start({});
    await runner.run();
    runner.close();
  });

  test('a live call discovered without an input is rechecked when the timer fires', async () => {
    const { runner } = fixture(async function* () {
      yield usage(150_000);
      yield result();
      runner.calls.reconcile(route);
      jest.advanceTimersByTime(COMPACT_IDLE_MS);
      expect(runner.inbox.pending).toBe(0);
    });
    runner.start({});
    await runner.run();
    runner.close();
  });

  test.each([false, true])('closing or ending a session cancels maintenance (close=%s)', async (close) => {
    const { runner } = fixture(async function* () {
      yield usage(150_000);
      yield result();
      expect(jest.getTimerCount()).toBe(1);
      if (close) runner.close();
    });
    runner.start({});
    await runner.run();
    expect(jest.getTimerCount()).toBe(0);
    jest.advanceTimersByTime(COMPACT_IDLE_MS);
    expect(runner.inbox.pending).toBe(0);
  });

  test('call hangup never closes the persistent Query or speaks any raw assistant output', async () => {
    const { runner, closed } = fixture(async function* () {
      yield msg({ type: 'system', subtype: 'task_notification', task_id: 'worker', status: 'completed' });
      yield msg({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'worker private output' } } });
      yield result();
    });
    runner.start({});
    runner.calls.notice({ type: 'started', route, sourceId: 'greet' });
    runner.calls.notice({ type: 'ended', route });
    expect(closed()).toBe(0);
    await runner.run();
    expect(closed()).toBe(0);
    runner.close();
    expect(closed()).toBe(1);
  });
});
