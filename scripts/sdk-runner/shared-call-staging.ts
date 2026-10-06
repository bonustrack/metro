import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hearSharedCall } from '../../apps/daemon/src/voice/shared.js';
import { isRecord } from '../../packages/core/src/is-record.js';
import * as h from './shared-call-harness.js';
import { inputOf, inputs, submit, toolEvents } from './shared-call-latency-metrics.js';
import { WORKLOAD } from './shared-call-latency-model.js';
import { attributes, speechInput, texts, type Block, type ModelRequest } from './shared-call-upstream.js';

const answered = new Set<string>();
const responses: { at: number; respondedAt: number; worker: boolean; blocks: Block[] }[] = [];
const send = (input: Record<string, unknown>): Block => ({ type: 'tool_use', name: 'mcp__metro__send', input });
const quiet = (): Block[] => [{ type: 'text', text: 'Staging probe bookkeeping finished.' }];
const take = (marker: string, text: string): boolean => {
  if (!text.includes(marker) || answered.has(marker)) return false;
  answered.add(marker);
  return true;
};
h.delays.write = WORKLOAD.writeMs;
h.delays.speech = WORKLOAD.speechMs;
h.upstream.script = async (request: ModelRequest): Promise<Block[]> => {
  const first = texts(Array.isArray(request.body.messages) ? request.body.messages[0] : undefined);
  let blocks = quiet();
  if (first.includes('STAGING_APPROVAL_WORKER')) {
    request.worker = true;
    if (take('worker-send', 'worker-send')) blocks = [send({ line: h.LINE, text: 'STAGING_APPROVED_WRITE' })];
  } else {
    const result: Block[] = [];
    for (const match of request.text.matchAll(/<(channel|call)\s[^>]*>[\s\S]*?<\/\1>/g)) {
      const wrapped = match[0];
      if (attributes(wrapped, match[1]).line !== h.LINE) continue;
      if (take('STAGING_HOLD', wrapped)) result.push(send({ line: h.LINE, text: 'STAGING_HELD_WRITE' }));
      if (take('STAGING_CALL_FIRST', wrapped)) result.push(send(speechInput(wrapped, 'STAGING_STALE_REPLY')));
      if (take('STAGING_NEXT_CHAT', wrapped)) result.push(send({ line: h.LINE, text: 'STAGING_NEXT_REPLY' }));
      if (take('STAGING_APPROVAL_START', wrapped)) result.push({ type: 'tool_use', name: 'Agent', input: {
        description: 'Staging approval worker', prompt: 'STAGING_APPROVAL_WORKER Send the exact approved fixture write.', subagent_type: 'general-purpose', run_in_background: true,
      } });
      if (take('STAGING_APPROVAL_CHAT', wrapped)) result.push({ type: 'text', text: 'STAGING_APPROVAL_CHAT_DONE' });
    }
    if (result.length > 0) blocks = result;
  }
  await Bun.sleep(WORKLOAD.thinkMs);
  responses.push({ at: request.at, respondedAt: Date.now(), worker: request.worker, blocks });
  return blocks;
};

function successful(text: string): void {
  const tools = toolEvents(text);
  assert.equal(tools.length, 1);
  assert.ok(tools[0].resultAt);
  assert.ok(!JSON.stringify(tools[0].result).includes('"is_error":true'));
}

async function callFirst(): Promise<void> {
  const fake = await h.call('fixture-staging-call-first');
  const runner = h.agent.runner;
  const session = runner.id;
  h.chat('STAGING_HOLD Begin the delayed foreground write.');
  await h.until('foreground write actually running', () => h.train.some((row) => row.args.text === 'STAGING_HELD_WRITE' && row.completedAt === null));
  const write = h.train.find((row) => row.args.text === 'STAGING_HELD_WRITE');
  assert.ok(write);
  const ingress = await submit('STAGING_CALL_FIRST', 'call', () => {
    hearSharedCall(fake.route, 'STAGING_CALL_FIRST Speak only in this exact call.', 'staging-call-first');
    return 'staging-call-first';
  });
  await h.until('call owns the sole SDK staging slot', () => inputOf(ingress.id).dispatchedAt !== null);
  const staged = { ...inputOf(ingress.id) };
  assert.equal(staged.consumedAt, null);
  assert.equal(write.completedAt, null);
  const endAt = Date.now();
  fake.end();
  await h.until('exact call route revoked', () => h.activity.snapshot().callState === 'ended');
  const revoked = { ...inputOf(ingress.id) };
  assert.notEqual(revoked.state, 'cancelled');
  const next = await submit('STAGING_NEXT_CHAT', 'chat', () => h.chat('STAGING_NEXT_CHAT Answer this valid ordinary chat.'));
  await h.until('ended speech refused and next chat finishes', () => toolEvents('STAGING_STALE_REPLY').some((row) => row.resultAt !== null)
    && h.train.some((row) => row.args.text === 'STAGING_NEXT_REPLY' && row.completedAt !== null), 60_000);
  await h.idle();
  const final = inputOf(ingress.id);
  const stale = toolEvents('STAGING_STALE_REPLY');
  assert.ok(write.completedAt !== null && final.consumedAt !== null && final.completedAt !== null);
  assert.ok(staged.dispatchedAt !== null && staged.dispatchedAt < write.completedAt);
  assert.ok(endAt < write.completedAt && final.consumedAt >= write.completedAt);
  assert.ok(h.upstream.seen.some((row) => row.text.includes('STAGING_CALL_FIRST')));
  assert.notEqual(final.state, 'cancelled');
  assert.equal(stale.length, 1);
  assert.match(JSON.stringify(stale[0].result), /"is_error":true/);
  assert.match(JSON.stringify(stale[0].result), /ended or changed/);
  assert.deepEqual(fake.synthesis, []);
  assert.deepEqual(fake.audio, []);
  assert.equal(h.sent('STAGING_STALE_REPLY'), 0);
  successful('STAGING_HELD_WRITE');
  successful('STAGING_NEXT_REPLY');
  assert.equal(h.sent('STAGING_HELD_WRITE'), 1);
  assert.equal(h.agent.runner, runner);
  assert.equal(runner.id, session);
  h.report('SDK-staged call revoked without false cancellation', { pass: true, endAt, ingress, staged, revoked, final, write, stale, next: inputOf(next.id), synthesis: fake.synthesis, audio: fake.audio, chatCopies: h.sent('STAGING_STALE_REPLY'), session });
}

async function approval(): Promise<void> {
  h.policy('ask');
  h.chat('STAGING_APPROVAL_START Start the background approval check.');
  await h.until('real SDK worker approval pending', () => h.pending().some((row) => row.preview.includes('STAGING_APPROVED_WRITE')) && h.activity.snapshot().approvals > 0, 60_000);
  const prompt = h.pending().find((row) => row.preview.includes('STAGING_APPROVED_WRITE'));
  assert.ok(prompt);
  const queued = await submit('STAGING_APPROVAL_CHAT', 'chat', () => h.chat('STAGING_APPROVAL_CHAT A valid ordinary input while approval waits.'));
  const answeredChat = (): boolean => h.events.some((row) => row.type === 'assistant' && row.parent_tool_use_id === null && isRecord(row.message) && texts(row.message.content).includes('STAGING_APPROVAL_CHAT_DONE'));
  await h.until('ordinary chat progresses without answering worker approval', answeredChat);
  const held = { ...inputOf(queued.id) };
  assert.ok(h.pending().some((row) => row.requestId === prompt.requestId));
  assert.ok(h.activity.snapshot().approvals > 0);
  assert.equal(h.sent('STAGING_APPROVED_WRITE'), 0);
  assert.notEqual(held.state, 'cancelled');
  const approvedAt = Date.now();
  h.chat(`yes ${prompt.requestId}`);
  await h.until('approved exact call and ordinary chat complete', () => h.train.some((row) => row.args.text === 'STAGING_APPROVED_WRITE' && row.completedAt !== null)
    && answeredChat() && h.activity.snapshot().workers === 0, 60_000);
  await h.idle();
  const write = h.train.filter((row) => row.args.text === 'STAGING_APPROVED_WRITE');
  assert.equal(write.length, 1);
  assert.ok(write[0].at >= approvedAt);
  assert.equal(h.pending().length, 0);
  assert.equal(h.activity.snapshot().approvals, 0);
  const final = inputOf(queued.id);
  assert.ok(final.consumedAt !== null && final.consumedAt >= final.acceptedAt);
  assert.notEqual(final.state, 'cancelled');
  h.report('pending worker approval survives ordinary input', { pass: true, requestId: prompt.requestId, held, approvedAt, final, write, actualSdkWorkerNotifications: h.events.filter((row) => row.type === 'system' && row.subtype === 'task_notification') });
  h.policy('allow');
}

function evidence(): string {
  const file = join(h.ROOT, 'staging-evidence.json');
  writeFileSync(file, JSON.stringify({ requests: h.upstream.seen, responses, timedEvents: h.timedEvents, inputs, activity: h.activity.snapshot(), snapshots: h.snapshots, train: h.train, calls: h.opened.map(({ route, synthesis, audio }) => ({ route, synthesis, audio })) }));
  return file;
}

try {
  await h.authProof();
  await h.boot();
  await callFirst();
  await approval();
  const stagedCounts = h.snapshots.map((snapshot) => (snapshot.inputs ?? []).filter((input) => input.dispatchedAt !== null && input.consumedAt === null && input.state !== 'cancelled').length);
  assert.ok(stagedCounts.every((count) => count <= 1));
  assert.deepEqual(h.upstream.failures, []);
  h.report('targeted SDK staging probes', { pass: true, maxUnconsumedStaged: Math.max(...stagedCounts), evidence: evidence(), upstreamRequests: h.upstream.seen.length, realProviderRequests: 0, paidCost: 0 });
} catch (err) {
  h.report('targeted SDK staging probes failed', { error: String(err), evidence: evidence() });
  throw err;
} finally {
  await h.close();
}
