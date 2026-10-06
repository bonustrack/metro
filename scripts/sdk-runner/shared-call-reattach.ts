import assert from 'node:assert/strict';
import { hearSharedCall } from '../../apps/daemon/src/voice/shared.js';
import * as h from './shared-call-harness.js';

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

async function queuedCall(fake: h.FakeCall): Promise<string> {
  h.chat('FIXTURE_HOLD_REATTACH hold the main turn during GET loss.');
  await h.until('main turn held before GET drop', () => h.upstream.held.has('FIXTURE_HOLD_REATTACH'));
  const prior = new Set(h.activity.snapshot().inputs?.map((input) => input.id));
  hearSharedCall(fake.route, 'FIXTURE_VOICE stale words while GET is detached.', 'fixture-before-detach');
  await h.until('call input queued before GET drop', () => h.activity.snapshot().inputs?.some((input) => input.kind === 'call' && !prior.has(input.id)) ?? false);
  const input = h.activity.snapshot().inputs?.find((entry) => entry.kind === 'call' && !prior.has(entry.id));
  assert.ok(input);
  assert.equal(input.state, 'accepted');
  assert.equal(input.dispatchedAt, null);
  return input.id;
}

export async function reattach(): Promise<void> {
  const agent = h.agent;
  const runner = agent.runner;
  const session = runner.id;
  const fake = await h.call('fixture-same-query-reattach');
  const approval = await pendingSpeech(fake);
  const queued = await queuedCall(fake);
  const resumeGet = h.detachGet();
  try {
    await h.until('real runner GET reconnect held', () => h.gets.size === 0 && h.heldGets.size > 0);
    assert.equal(runner.calls.live, true);
    fake.end();
    await h.until('detached end revokes daemon approval', () => h.pending().length === 0);
    assert.equal(runner.calls.live, true);
    assert.equal(approval.aborted, false);
    resumeGet();
    await h.until('same runner reconciles ended call', () => h.gets.size > 0 && !runner.calls.live && h.activity.snapshot().approvals === 0);
    assert.equal(approval.aborted, true);
    assert.equal(h.activity.snapshot().inputs?.find((input) => input.id === queued)?.state, 'cancelled');
    const boundaries = h.events.filter((event) => event.subtype === 'compact_boundary').length;
    h.upstream.inputTokens = 130_000;
    h.upstream.holdCompaction = true;
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
    assert.ok(!h.upstream.seen.some((request) => request.text.includes('stale words while GET is detached.')));
    assert.deepEqual(fake.synthesized, []);
    h.report('same Query GET recovery', { pendingCallCancelled: true, approvalSignalAborted: true, pendingApprovalRevoked: true, runnerLiveCleared: true, idleCompactionCompleted: true, nextChatAnswered: true, sameRunnerAndQuery: true, sameSession: true, replacementCallOpened: false });
  } finally {
    resumeGet();
  }
}
