import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { CALL_NOTICE, CALL_STATE, type CallRoute } from '../../packages/core/src/call.js';
import { endSharedCall, hearSharedCall, openSharedCall, type SharedCallTransport } from '../../apps/daemon/src/voice/shared.js';
import * as h from './shared-call-harness.js';

interface Frame { id: string; data: Record<string, unknown> }

async function stream(cursor?: string): Promise<{ frames: Frame[]; close(): Promise<void> }> {
  const abort = new AbortController();
  const response = await h.rawGet(abort.signal, cursor);
  assert.equal(response.status, 200);
  assert.ok(response.body);
  const reader = response.body.getReader();
  const frames: Frame[] = [];
  const errors: unknown[] = [];
  const pump = async (): Promise<void> => {
    let buffer = '';
    const decoder = new TextDecoder();
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return;
      buffer += decoder.decode(chunk.value, { stream: true });
      let boundary: number;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = frame.split('\n').find((line) => line.startsWith('data: '));
        if (data !== undefined) frames.push({ id: frame.split('\n').find((line) => line.startsWith('id: '))?.slice(4) ?? '', data: JSON.parse(data.slice(6)) as Record<string, unknown> });
      }
    }
  };
  const done = pump().catch((err: unknown) => {
    if (!abort.signal.aborted) {
      errors.push(err);
      process.stderr.write(`Fixture SSE failure: ${String(err)}\n`);
    }
  });
  return { frames, close: async () => { abort.abort(); await done; assert.deepEqual(errors, []); } };
}

const notice = (frame: Frame, type: string): boolean => frame.data.method === CALL_NOTICE && (frame.data.params as { type?: string }).type === type;

export async function reconnect(): Promise<void> {
  const session = h.agent.runner.id;
  await h.agent.link.close();
  await h.until('runner GET detached', () => h.gets.size === 0);
  const first = await stream();
  assert.equal(h.mcp.switchModel('fixture-replay-cursor'), true);
  await h.until('SSE cursor', () => first.frames.length > 0);
  const cursor = first.frames.at(-1)?.id;
  assert.ok(cursor);
  const route: CallRoute = { agentId: h.AGENT, line: h.LINE, from: h.FROM, callId: 'fixture-sse', generation: randomUUID() };
  const sourceId = randomUUID();
  let terminated = 0;
  const transport: SharedCallTransport = {
    enqueue: (action) => { action.status('started'); action.status('completed'); return true; },
    terminate: () => { terminated++; },
  };
  assert.equal(openSharedCall(route, sourceId, transport), true);
  hearSharedCall(route, 'Fixture transcript that must never replay.', 'fixture-ephemeral');
  await h.rawSend({ line: h.LINE, text: 'Fixture non-replayed action.', speech: h.target(route, sourceId) });
  await h.until('all live call notice types', () => ['started', 'heard', 'speech'].every((type) => first.frames.some((frame) => notice(frame, type))));
  assert.equal(h.mcp.switchModel('fixture-replay-sentinel'), true);
  await h.until('replay sentinel saved', () => first.frames.some((frame) => JSON.stringify(frame.data).includes('fixture-replay-sentinel')));
  await first.close();
  await h.until('GET detached before hangup', () => h.gets.size === 0);
  endSharedCall(route);
  assert.equal(terminated, 1);
  const second = await stream(cursor);
  await h.until('non-call sentinel replayed', () => second.frames.some((frame) => JSON.stringify(frame.data).includes('fixture-replay-sentinel')));
  await h.until('fresh current call snapshot', () => second.frames.some((frame) => frame.data.method === CALL_STATE));
  assert.deepEqual(second.frames.filter((frame) => frame.data.method === CALL_STATE).map((frame) => frame.data.params), [{ route: null }]);
  assert.equal(second.frames.filter((frame) => frame.data.method === CALL_NOTICE).length, 0);
  const replacement = { ...route, generation: randomUUID() };
  assert.equal(openSharedCall(replacement, 'fixture-after-reconnect', transport), true);
  await h.until('replacement after detached end', () => second.frames.some((frame) => notice(frame, 'started')));
  endSharedCall(replacement);
  await h.until('replacement ended notice', () => second.frames.some((frame) => notice(frame, 'ended')));
  assert.ok(!JSON.stringify(second.frames).includes('Fixture transcript that must never replay.'));
  await second.close();
  await h.agent.stop();
  await h.agent.done;
  await h.boot();
  h.chat('FIXTURE_CHAT_AFTER_BRIDGE_RECONNECT');
  await h.until('chat after bridge reconnect', () => h.sent('FIXTURE_CHAT_AFTER_BRIDGE_RECONNECT') === 1);
  await h.idle();
  assert.equal(h.agent.runner.id, session);
  h.report('GET reconnect and detached hangup', { liveNoticeTypes: ['started', 'heard', 'speech'], staleNoticesReplayed: 0, nonCallReplayPreserved: true, detachedEndAllowsReplacement: true, nextChatAnswered: true, resumedSameSession: true });
}
