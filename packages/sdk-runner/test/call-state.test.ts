import { describe, expect, test } from 'bun:test';
import type { CallNotice, CallRoute } from '@metro-labs/core/call';
import type { RunnerInput } from '@metro-labs/core/runner-activity';
import { RunnerCalls } from '../src/calls.ts';
import { Inbox } from '../src/inbox.ts';
import { SessionWatch } from '../src/session-watch.ts';

const route: CallRoute = { agentId: 'agent', line: 'metro://xmtp/a/chat', from: 'metro://xmtp/a/user/caller', callId: 'call', generation: 'generation' };
const sourceId = 'private-source';
const start = (calls: RunnerCalls): void => calls.notice({ type: 'started', route, sourceId });
const target = { line: route.line, text: 'reply', speech: { callId: route.callId, generation: route.generation, sourceId } };

describe('current call reconciliation after GET reattach', () => {
  test('no current call cancels stale call input and approvals, preserving queued chat', async () => {
    const inputs: RunnerInput[] = [];
    const inbox = new Inbox(undefined, { input: (input) => inputs.push(input) });
    const calls = new RunnerCalls(inbox);
    start(calls);
    calls.notice({ type: 'heard', route, sourceId: 'heard', text: 'stale words' });
    const binding = calls.approval('mcp__metro__send', target);
    expect(binding?.signal.aborted).toBe(false);
    inbox.push('chat', 'keep chat');
    calls.reconcile(null);
    expect(calls.live).toBe(false);
    expect(binding?.signal.aborted).toBe(true);
    expect(inputs.filter((input) => input.state === 'cancelled')).toHaveLength(2);
    calls.notice({ type: 'heard', route, sourceId: 'late', text: 'late words' });
    const read = inbox[Symbol.asyncIterator]();
    expect((await read.next()).value?.message.content).toBe('keep chat');
    expect((await read.next()).value?.message.content).toContain('ended');
    expect(inbox.pending).toBe(0);
    expect(inbox.unanswered()).toHaveLength(1);
    inbox.close();
  });

  test('hangup cancels only host-queued words and keeps the SDK-staged input observable', async () => {
    const inputs: RunnerInput[] = [];
    const watch = new SessionWatch(() => false);
    const inbox = new Inbox(undefined, { ready: () => watch.admitting, dispatch: (input) => watch.dispatched(input.uuid), input: (input) => inputs.push(input) });
    const calls = new RunnerCalls(inbox);
    watch.observe({ type: 'system', subtype: 'session_state_changed', state: 'running' });
    watch.observe({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'write', name: 'mcp__metro__send' }] } });
    start(calls);
    const read = inbox[Symbol.asyncIterator]();
    const staged = (await read.next()).value;
    const stagedId = staged?.uuid ?? 'missing';
    expect(staged?.priority).toBeUndefined();
    expect(watch.writing).toBe(true);
    const binding = calls.approval('mcp__metro__send', target);
    calls.notice({ type: 'heard', route, sourceId: 'host-queued', text: 'words still in the host' });
    const chat = inbox.push('chat', 'durable after hangup');
    calls.notice({ type: 'ended', route });
    expect(binding?.signal.aborted).toBe(true);
    expect(calls.approval('mcp__metro__send', target)).toBeNull();
    expect(inputs.filter((input) => input.state === 'cancelled')).toHaveLength(1);
    expect(inputs.filter((input) => input.id === stagedId).at(-1)).toMatchObject({ state: 'accepted', consumedAt: null, completedAt: null });
    expect(watch.admitting).toBe(false);
    watch.observe({ type: 'command_lifecycle', state: 'started', command_uuid: stagedId, parent_tool_use_id: 'worker' });
    expect(watch.admitting).toBe(false);
    watch.observe({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'write' }] } });
    expect(watch.admitting).toBe(false);
    watch.observe({ type: 'command_lifecycle', state: 'started', command_uuid: stagedId });
    inbox.started([stagedId]);
    expect(inputs.filter((input) => input.id === stagedId).at(-1)).toMatchObject({ state: 'consumed', consumedAt: expect.any(Number) });
    const ended = (await read.next()).value;
    expect(ended?.message.content).toContain('ended');
    watch.observe({ type: 'command_lifecycle', state: 'started', command_uuid: ended?.uuid });
    expect((await read.next()).value?.uuid).toBe(chat);
    expect(inbox.unanswered()).toEqual([expect.objectContaining({ uuid: chat, state: 'queued' })]);
    inbox.finished([stagedId]);
    expect(inputs.filter((input) => input.id === stagedId).at(-1)).toMatchObject({ state: 'completed', completedAt: expect.any(Number) });
    expect(inbox.pending).toBe(0);
    inbox.close();
  });

  test('the same current route keeps sources and approvals without replaying a greeting', () => {
    const inbox = new Inbox();
    const calls = new RunnerCalls(inbox);
    start(calls);
    const binding = calls.approval('mcp__metro__send', target);
    calls.reconcile({ ...route });
    expect(calls.live).toBe(true);
    expect(inbox.pending).toBe(1);
    expect(binding?.signal.aborted).toBe(false);
    expect(calls.approval('mcp__metro__send', target)?.signal).toBe(binding?.signal);
    inbox.close();
  });

  test('a changed route invalidates old work and accepts future words without replay', async () => {
    const inbox = new Inbox();
    const calls = new RunnerCalls(inbox);
    start(calls);
    const binding = calls.approval('mcp__metro__send', target);
    const current = { ...route, generation: 'replacement' };
    calls.reconcile(current);
    expect(binding?.signal.aborted).toBe(true);
    expect(calls.live).toBe(true);
    const read = inbox[Symbol.asyncIterator]();
    expect((await read.next()).value?.message.content).toContain('ended');
    expect(inbox.pending).toBe(0);
    calls.notice({ type: 'started', route: current, sourceId: 'not-replayed' });
    calls.notice({ type: 'ended', route });
    calls.notice({ type: 'heard', route, sourceId: 'stale', text: 'old' });
    expect(inbox.pending).toBe(0);
    calls.notice({ type: 'heard', route: current, sourceId: 'fresh', text: 'new words' });
    expect((await read.next()).value?.message.content).toContain('new words');
    calls.reconcile(null);
    calls.reconcile(current);
    expect(calls.live).toBe(false);
    inbox.close();
  });

  test('retiring old tombstones never stops new calls after 512 generations', async () => {
    const inbox = new Inbox();
    const calls = new RunnerCalls(inbox);
    const read = inbox[Symbol.asyncIterator]();
    for (let i = 0; i < 520; i += 1) {
      const current = { ...route, generation: String(i) };
      calls.notice({ type: 'started', route: current, sourceId: 'greeting' });
      expect(calls.live).toBe(true);
      expect((await read.next()).value?.message.content).toContain(`generation="${i}"`);
      calls.notice({ type: 'ended', route: current });
      expect((await read.next()).value?.message.content).toContain('ended');
    }
    calls.notice({ type: 'started', route: { ...route, generation: '519' }, sourceId: 'replay' });
    expect(calls.live).toBe(false);
    expect(inbox.pending).toBe(0);
    inbox.close();
  });
});

test('one safe failure fact survives immediate hangup while reasoning stays gated', async () => {
  const watch = new SessionWatch(() => false);
  const inbox = new Inbox(undefined, { ready: () => watch.safe, dispatch: () => watch.dispatched() });
  const calls = new RunnerCalls(inbox);
  watch.observe({ type: 'system', subtype: 'session_state_changed', state: 'running' });
  start(calls);
  const failed: CallNotice = { type: 'speech', route, sourceId, actionId: 'private-action', status: 'failed' };
  calls.notice({ ...failed, sourceId: 'unknown' });
  calls.notice({ ...failed, route: { ...route, generation: 'stale' } });
  calls.notice(failed);
  calls.notice(failed);
  calls.notice({ type: 'ended', route });
  calls.notice(failed);
  expect(calls.live).toBe(false);
  expect(inbox.pending).toBe(2);
  let dispatched = false;
  const read = inbox[Symbol.asyncIterator]();
  const pending = read.next().then((next) => { dispatched = true; return next; });
  await Bun.sleep(20);
  expect(dispatched).toBe(false);
  watch.observe({ type: 'system', subtype: 'session_state_changed', state: 'idle' });
  inbox.notify();
  const feedback = (await pending).value;
  expect(feedback?.message.content).toContain('Speech delivery failed');
  expect(feedback?.message.content).toContain('do not retry, speak, or post to chat');
  expect(feedback?.message.content).not.toContain('private-');
  expect(feedback?.message.content).not.toContain('<call');
  expect(feedback?.priority).toBeUndefined();
  watch.observe({ type: 'system', subtype: 'session_state_changed', state: 'idle' });
  inbox.notify();
  expect((await read.next()).value?.message.content).toContain('ended');
  expect(inbox.pending).toBe(0);
  inbox.close();
});
