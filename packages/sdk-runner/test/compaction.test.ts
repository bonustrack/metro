import { afterEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { CallRoute } from '@metro-labs/core/call';
import { Runner, type OpenSession } from '../src/runner.ts';
import { SessionStore } from '../src/session-store.ts';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
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
  const reads = (): AsyncIterator<SDKUserMessage> => {
    if (prompt === undefined) throw new Error('runner not started');
    return prompt[Symbol.asyncIterator]();
  };
  return { runner, store, reads, closed: () => closed };
}

describe('idle compaction headroom', () => {
  test('the first high context sample compacts instead of setting an unreachable fresh floor', async () => {
    const { runner, reads, store } = fixture(async function* () { yield usage(150_000); yield result(); });
    runner.start({});
    await runner.run();
    expect((await reads().next()).value?.message.content).toBe('/compact');
    expect(store.recover().context).toBe(150_000);
    runner.close();
  });

  test('a saved high-context resume compacts before pending chat without changing its uuid or consumed state', async () => {
    const { runner, reads, store } = fixture(async function* () { yield result(); }, 150_000);
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
      const compact = (await read.next()).value;
      expect(compact?.message.content).toBe('/compact');
      yield msg({ type: 'command_lifecycle', state: 'started', command_uuid: compact?.uuid });
      yield msg({ type: 'system', subtype: 'status', status: 'compacting' });
      yield msg({ type: 'system', subtype: 'compact_boundary' });
      yield result(compact?.uuid === undefined ? [] : [compact.uuid]);
      yield usage(10_000);
      yield result();
      yield usage(160_000);
      yield result();
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
