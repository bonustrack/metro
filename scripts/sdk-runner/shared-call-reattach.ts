import assert from 'node:assert/strict';
import { hearSharedCall, sharedCalls } from '../../apps/daemon/src/voice/shared.js';
import { isRecord } from '../../packages/core/src/is-record.js';
import * as h from './shared-call-harness.js';
import { inputOf, submit, toolEvents, type Ingress } from './shared-call-latency-metrics.js';

async function pendingSpeech(fake: h.FakeCall): Promise<AbortSignal> {
  h.policy('ask');
  const sourceId = h.chat('FIXTURE_APPROVAL keep this call speech pending during reconnect.');
  await h.until('approval before GET drop', () => h.pending().length > 0 && h.activity.snapshot().approvals > 0);
  h.policy('allow');
  await h.idle();
  const binding = h.agent.runner.calls.approval('mcp__metro__send', { line: h.LINE, text: 'Approved fixture speech.', speech: h.target(fake.route, sourceId) });
  assert.ok(binding);
  assert.equal(binding.signal.aborted, false);
  return binding.signal;
}

async function stagedCall(fake: h.FakeCall): Promise<Ingress> {
  h.chat('FIXTURE_HOLD_REATTACH hold the main turn during GET loss.');
  await h.until('main turn held before GET drop', () => h.upstream.held.has('FIXTURE_HOLD_REATTACH'));
  const ingress = await submit('fixture-before-detach', 'call', () => {
    hearSharedCall(fake.route, 'FIXTURE_VOICE stale words while GET is detached.', 'fixture-before-detach');
    return 'fixture-before-detach';
  });
  const input = inputOf(ingress.id);
  assert.equal(input.state, 'accepted');
  assert.notEqual(input.dispatchedAt, null);
  assert.equal(input.consumedAt, null);
  return ingress;
}

export async function reattach(): Promise<void> {
  const agent = h.agent;
  const runner = agent.runner;
  const session = runner.id;
  const fake = await h.call('fixture-same-query-reattach');
  const approval = await pendingSpeech(fake);
  const ingress = await stagedCall(fake);
  const staged = { ...inputOf(ingress.id) };
  const resumeGet = h.detachGet();
  try {
    await h.until('real runner GET reconnect held', () => h.gets.size === 0 && h.heldGets.size > 0);
    assert.equal(runner.calls.live, true);
    const endAt = Date.now();
    fake.end();
    assert.equal(sharedCalls.valid({ route: fake.route, sourceId: ingress.sourceId }), false);
    await h.until('detached end revokes daemon approval', () => h.pending().length === 0);
    assert.equal(runner.calls.live, true);
    assert.equal(approval.aborted, false);
    resumeGet();
    await h.until('same runner reconciles ended call', () => h.gets.size > 0 && !runner.calls.live && h.activity.snapshot().approvals === 0);
    assert.equal(approval.aborted, true);
    assert.notEqual(inputOf(ingress.id).state, 'cancelled');
    assert.equal(inputOf(ingress.id).consumedAt, null);
    const boundaries = h.events.filter((event) => event.subtype === 'compact_boundary').length;
    h.upstream.inputTokens = 130_000;
    h.upstream.holdCompaction = true;
    const releasedAt = Date.now();
    h.upstream.release('FIXTURE_HOLD_REATTACH');
    await h.until('idle compaction after same Query recovery', () => h.upstream.held.has('compaction') && h.activity.snapshot().mainPhase === 'compacting');
    h.upstream.inputTokens = 50;
    h.upstream.holdCompaction = false;
    h.upstream.release('compaction');
    await h.until('reconnected idle compaction completed', () => h.events.filter((event) => event.subtype === 'compact_boundary').length === boundaries + 1);
    await h.until('reconnected approval worker settled', () => h.activity.snapshot().workers === 0);
    await h.idle();
    h.chat('FIXTURE_CHAT_AFTER_SAME_QUERY_RECONNECT');
    await h.until('chat after same Query reconnect', () => h.sent('FIXTURE_CHAT_AFTER_SAME_QUERY_RECONNECT') === 1);
    await h.idle();
    assert.equal(h.agent, agent);
    assert.equal(h.agent.runner, runner);
    assert.equal(runner.id, session);
    assert.equal(runner.calls.live, false);
    const final = inputOf(ingress.id);
    const stale = toolEvents('Voice fixture answer.').filter((row) => isRecord(row.input.speech) && row.input.speech.sourceId === ingress.sourceId);
    assert.ok(final.consumedAt !== null && final.consumedAt >= releasedAt);
    assert.equal(final.state, 'completed');
    assert.equal(stale.length, 1);
    assert.equal(stale[0].input.line, h.LINE);
    assert.deepEqual(stale[0].input.speech, h.target(fake.route, ingress.sourceId));
    assert.match(JSON.stringify(stale[0].result), /"is_error":true/);
    assert.match(JSON.stringify(stale[0].result), /ended or changed/);
    assert.deepEqual(fake.synthesized, []);
    assert.deepEqual(fake.synthesis, []);
    assert.deepEqual(fake.audio, []);
    assert.equal(h.sent('Voice fixture answer.'), 0);
    h.report('same Query GET recovery', { ingress, staged, endAt, releasedAt, final, stale, authorityRevoked: true, lateSynthesis: 0, lateAudio: 0, chatCopies: 0,
      approvalSignalAborted: true, pendingApprovalRevoked: true, runnerLiveCleared: true, idleCompactionCompleted: true, nextChatAnswered: true, sameRunnerAndQuery: true, sameSession: true, replacementCallOpened: false });
  } finally {
    resumeGet();
  }
}
