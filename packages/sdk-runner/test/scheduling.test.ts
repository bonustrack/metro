import { afterEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { CallRoute } from '@metro-labs/core/call';
import { approvalsThrough } from '../src/approvals.ts';
import { Runner, type OpenSession } from '../src/runner.ts';
import { SessionStore } from '../src/session-store.ts';
import { SessionWatch } from '../src/session-watch.ts';

const dirs: string[] = [];
const runners: Runner[] = [];
afterEach(() => {
  for (const runner of runners.splice(0)) runner.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const state = (value: string): Record<string, unknown> => ({ type: 'system', subtype: 'session_state_changed', state: value });
const tool = (id: string, name = 'mcp__metro__send'): Record<string, unknown> => ({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id, name }] } });
const done = (id: string): Record<string, unknown> => ({ type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'done' }] } });
const started = (uuid: string): Record<string, unknown> => ({ type: 'command_lifecycle', state: 'started', command_uuid: uuid });
const result = (uuids: string[] = []): Record<string, unknown> => ({ type: 'result', subtype: 'success', user_message_uuids: uuids });
const message = (value: Record<string, unknown>): SDKMessage => value as unknown as SDKMessage;

function fixture(events: () => AsyncGenerator<SDKMessage>): { runner: Runner; store: SessionStore; next: () => Promise<SDKUserMessage>; closes: () => number } {
  const dir = mkdtempSync(join(tmpdir(), 'sdk-scheduling-'));
  dirs.push(dir);
  const store = new SessionStore(join(dir, 'session.json'), join(dir, 'claude'), dir);
  let input: AsyncIterator<SDKUserMessage>;
  let closes = 0;
  const open: OpenSession = (params) => {
    input = params.prompt[Symbol.asyncIterator]();
    return { [Symbol.asyncIterator]: events, applyFlagSettings: () => Promise.resolve(), close: () => { closes += 1; } } as ReturnType<OpenSession>;
  };
  const runner = new Runner({ store, open, readOnly: () => false });
  runners.push(runner);
  runner.start({});
  const next = async (): Promise<SDKUserMessage> => {
    const received = await Promise.race([input.next(), Bun.sleep(80).then(() => undefined)]);
    if (received?.value === undefined) throw new Error('no input at the safe SDK admission boundary');
    expect(received.value.priority).toBeUndefined();
    return received.value;
  };
  return { runner, store, next, closes: () => closes };
}

describe('bounded SDK input admission', () => {
  test('normal SDK input can be staged during a tool without making compaction safe', () => {
    const watch = new SessionWatch(() => true);
    watch.observe(state('running'));
    watch.observe(tool('read', 'mcp__metro__read'));
    expect(watch.admitting).toBe(true);
    watch.dispatched(randomUUID());
    watch.observe(done('read'));
    expect(watch.admitting).toBe(false);
    expect(watch.safe).toBe(false);
  });

  test('writes retain maintenance safety while approvals and compaction gate staging', () => {
    const watch = new SessionWatch(() => false);
    watch.observe(state('running'));
    watch.observe(tool('write'));
    watch.observe(tool('read', 'Read'));
    watch.observe(done('unrelated'));
    watch.observe(result());
    expect(watch.admitting).toBe(true);
    expect(watch.writing).toBe(true);
    expect(watch.safe).toBe(false);
    watch.observe(state('requires_action'));
    watch.observe(done('read'));
    watch.observe({ ...state('idle'), parent_tool_use_id: 'worker' });
    watch.observe({ ...state('running'), parent_tool_use_id: 'worker' });
    expect(watch.admitting).toBe(false);
    watch.observe({ type: 'system', subtype: 'status', status: 'compacting' });
    watch.observe(state('running'));
    expect(watch.admitting).toBe(false);
    watch.observe({ type: 'system', subtype: 'compact_boundary' });
    expect(watch.admitting).toBe(true);
    expect(watch.writing).toBe(true);
    watch.observe(done('write'));
    expect(watch.writing).toBe(false);
    expect(watch.safe).toBe(false);
  });

  test('completion storms cannot admit a second input before exact main consumption', () => {
    const watch = new SessionWatch(() => false);
    const first = randomUUID();
    watch.dispatched(first);
    watch.observe(state('running'));
    for (let index = 0; index < 100; index += 1) {
      watch.observe(result([randomUUID()]));
      watch.observe({ type: 'system', subtype: 'task_notification', task_id: `worker${index}`, status: 'completed' });
      watch.observe({ ...started(first), parent_tool_use_id: 'worker' });
      watch.observe({ ...result([first]), parent_tool_use_id: 'worker' });
      expect(watch.admitting).toBe(false);
    }
    watch.observe(state('idle'));
    expect(watch.admitting).toBe(false);
    watch.observe(started(first));
    expect(watch.admitting).toBe(true);
    expect(watch.safe).toBe(false);
    const second = randomUUID();
    watch.dispatched(second);
    expect(watch.admitting).toBe(false);
    watch.observe(result([first]));
    expect(watch.admitting).toBe(false);
    watch.observe(result([second]));
    expect(watch.admitting).toBe(true);
  });

  test('model activity permits one normal SDK input without requiring a host credit', () => {
    const watch = new SessionWatch(() => false);
    watch.observe(state('running'));
    watch.observe({ type: 'stream_event', event: { type: 'message_start', message: {} } });
    expect(watch.safe).toBe(false);
    expect(watch.admitting).toBe(true);
    const input = randomUUID();
    watch.dispatched(input);
    watch.observe({ ...started(input), parent_tool_use_id: 'worker' });
    watch.observe({ ...result([input]), parent_tool_use_id: 'worker' });
    watch.observe(done('unknown'));
    expect(watch.admitting).toBe(false);
    watch.observe(tool('one', 'Read'));
    watch.observe(started(input));
    expect(watch.admitting).toBe(true);
    watch.observe(done('one'));
    expect(watch.admitting).toBe(true);
    watch.observe(tool('two', 'Read'));
    expect(watch.admitting).toBe(true);
  });

  test('exact main consumption frees the next bounded slot before another model request', async () => {
    const f = fixture(async function* () {
      yield message(state('running'));
      yield message(tool('write'));
      f.runner.inbox.push('call', 'voice');
      yield message(done('write'));
      const voice = await f.next();
      expect(voice.message.content).toBe('voice');
      f.runner.inbox.push('chat', 'chat');
      f.runner.inbox.push('chat', 'typed speech');
      yield message({ type: 'system', subtype: 'status', status: 'requesting' });
      yield message(tool('next-write'));
      yield message(done('next-write'));
      yield message(started(voice.uuid ?? 'missing'));
      const chat = await f.next();
      expect(chat.message.content).toBe('chat');
      yield message({ type: 'stream_event', event: { type: 'message_start', message: {} } });
      yield message(tool('reply'));
      yield message(done('reply'));
      yield message(started(chat.uuid ?? 'missing'));
      expect((await f.next()).message.content).toBe('typed speech');
      expect(f.runner.inbox.pending).toBe(0);
      expect(f.closes()).toBe(0);
    });
    await f.runner.run();
  });

  test('staging during a write neither consumes durable input nor settles a racing approval', async () => {
    let release: (answer: 'allow' | 'deny') => void = () => { throw new Error('approval not requested'); };
    let approved = false;
    const canUse = approvalsThrough({ ask: () => new Promise((resolve) => { release = resolve; }) });
    const pending = canUse('mcp__metro__send', {}, { signal: new AbortController().signal, toolUseID: 'write', requestId: 'approval' }).then((verdict) => {
      approved = verdict.behavior === 'allow';
      return verdict;
    });
    const f = fixture(async function* () {
      yield message(state('running'));
      yield message(tool('write'));
      const id = f.runner.chat({ content: 'fresh chat during write', meta: {} });
      expect((await f.next()).uuid).toBe(id);
      yield message(state('requires_action'));
      yield message(result([randomUUID()]));
      expect(approved).toBe(false);
      expect(f.store.unanswered()).toEqual([expect.objectContaining({ uuid: id, state: 'queued' })]);
      release('allow');
      expect(await pending).toMatchObject({ behavior: 'allow' });
      yield message(state('running'));
      yield message(done('write'));
      expect(f.store.unanswered()).toEqual([expect.objectContaining({ uuid: id, state: 'queued' })]);
      yield message(started(id));
      expect(f.store.unanswered()).toEqual([expect.objectContaining({ uuid: id, state: 'started' })]);
      yield message(result([id]));
      expect(f.store.unanswered()).toEqual([]);
      expect(f.closes()).toBe(0);
    });
    await f.runner.run();
  });

  test('a main UUID stamp acknowledges admission without settling its durable ledger', async () => {
    let id: string;
    const f = fixture(async function* () {
      expect((await f.next()).uuid).toBe(id);
      yield message(state('running'));
      yield message({ type: 'assistant', parent_tool_use_id: null, user_message_uuids: [id], message: { content: [] } });
      yield message(result([randomUUID()]));
      expect(f.store.unanswered()).toEqual([expect.objectContaining({ uuid: id, state: 'started' })]);
      expect((await f.next()).message.content).toBe('context');
    });
    id = f.runner.chat({ content: 'durable', meta: {} });
    f.runner.inbox.push('note', 'context');
    await f.runner.run();
    expect(f.store.recover().interrupted).toEqual([expect.objectContaining({ uuid: id })]);
  });

  test('a buffered idle does not schedule compaction ahead of unacknowledged input', async () => {
    const f = fixture(async function* () {
      const first = await f.next();
      yield message(started(first.uuid ?? 'missing'));
      yield message(state('running'));
      yield message({ type: 'stream_event', event: { type: 'message_start', message: { usage: { input_tokens: 150_000 } } } });
      yield message(tool('read', 'Read'));
      const second = f.runner.chat({ content: 'fresh input', meta: {} });
      yield message(done('read'));
      expect((await f.next()).uuid).toBe(second);
      yield message(result(first.uuid === undefined ? [] : [first.uuid]));
      yield message(state('idle'));
      expect(f.runner.inbox.pending).toBe(0);
      yield message(started(second));
      yield message(state('running'));
      expect(f.runner.inbox.pending).toBe(0);
    });
    f.runner.chat({ content: 'initial input', meta: {} });
    await f.runner.run();
  });

  test('chat, call and notes progress fairly through five completion turns with no idle', async () => {
    const seen: string[] = [];
    const f = fixture(async function* () {
      yield message(state('running'));
      yield message(tool('initial'));
      f.runner.inbox.push('chat', 'chat1');
      f.runner.inbox.push('chat', 'chat2');
      f.runner.inbox.push('call', 'call1');
      f.runner.inbox.push('call', 'call2');
      f.runner.inbox.push('note', 'note');
      yield message(done('initial'));
      for (let index = 0; index < 5; index += 1) {
        const input = await f.next();
        seen.push(String(input.message.content));
        yield message(started(input.uuid ?? 'missing'));
        for (let worker = 0; worker < 5; worker += 1) yield message({ type: 'system', subtype: 'task_notification', task_id: `${index}-${worker}`, status: 'completed' });
        yield message(tool(`turn${index}`));
        yield message(done(`turn${index}`));
      }
      expect(f.closes()).toBe(0);
    });
    await f.runner.run();
    expect(seen).toEqual(['chat1', 'call1', 'note', 'chat2', 'call2']);
    expect(f.runner.inbox.pending).toBe(0);
  });

  test('typed speech stays exactly bound and hangup cancels queued words during notification pressure', async () => {
    const route: CallRoute = { agentId: 'agent', line: 'metro://xmtp/a/chat', from: 'metro://xmtp/a/user/caller', callId: 'call', generation: 'generation' };
    const speech = { callId: route.callId, generation: route.generation, sourceId: 'typed' };
    const f = fixture(async function* () {
      yield message(state('running'));
      yield message(tool('working', 'Read'));
      f.runner.calls.reconcile(route);
      const typed = f.runner.chat({ content: 'say ABC on this call', meta: { line: route.line, from: route.from, call_id: route.callId, call_generation: route.generation, call_source_id: speech.sourceId } });
      f.runner.calls.notice({ type: 'heard', route, sourceId: 'words', text: 'do not replay after hangup' });
      yield message(done('working'));
      expect((await f.next()).uuid).toBe(typed);
      yield message(started(typed));
      const target = { line: route.line, text: 'ABC', speech };
      const binding = f.runner.calls.approval('mcp__metro__send', target);
      expect(binding?.call).toEqual({ route, sourceId: speech.sourceId });
      const canUse = approvalsThrough({ ask: (_ask, signal) => new Promise((resolve) => {
        signal.addEventListener('abort', () => { resolve('deny'); }, { once: true });
      }) }, undefined, (name, input) => f.runner.calls.approval(name, input));
      const pending = canUse('mcp__metro__send', target, { signal: new AbortController().signal, toolUseID: 'speech', requestId: 'approval' });
      yield message(tool('speech'));
      yield message(state('requires_action'));
      for (let index = 0; index < 5; index += 1) yield message({ type: 'system', subtype: 'task_notification', task_id: `worker${index}`, status: 'completed' });
      f.runner.calls.notice({ type: 'ended', route });
      expect(await pending).toMatchObject({ behavior: 'deny' });
      expect(binding?.signal.aborted).toBe(true);
      expect(f.runner.calls.approval('mcp__metro__send', target)).toBeNull();
      expect(f.runner.calls.approval('Bash', { command: 'still working' })).toBeUndefined();
      expect(f.closes()).toBe(0);
      const chat = f.runner.chat({ content: 'ordinary chat after hangup', meta: {} });
      yield message(state('running'));
      yield message(done('speech'));
      const ended = await f.next();
      expect(ended.message.content).toContain('ended');
      yield message(started(ended.uuid ?? 'missing'));
      yield message(result());
      expect((await f.next()).uuid).toBe(chat);
      expect(f.runner.inbox.pending).toBe(0);
      expect(f.store.unanswered()).toContainEqual(expect.objectContaining({ uuid: typed, state: 'started' }));
      expect(f.closes()).toBe(0);
    });
    await f.runner.run();
  });
});
