import assert from 'node:assert/strict';
import { hearSharedCall, openSharedCall } from '../../apps/daemon/src/voice/shared.js';
import { answerPrompt } from '../../apps/daemon/src/approvals/pending.js';
import * as h from './shared-call-harness.js';
import { STORY } from './shared-call-upstream.js';
import { resumedCompaction } from './shared-call-compaction.js';
import { reconnect } from './shared-call-reconnect.js';
import { reattach } from './shared-call-reattach.js';

function rejected(result: Record<string, unknown>, reason: RegExp): void {
  assert.match(JSON.stringify(result), /"isError":true/);
  assert.match(JSON.stringify(result), reason);
}

async function typedStory(): Promise<h.FakeCall> {
  const fake = await h.call();
  const sourceId = h.chat('FIXTURE_STORY Please tell me a story in this call, not in chat.');
  await h.until('typed story audio', () => fake.frames.length === 1);
  await h.idle();
  assert.deepEqual(fake.synthesized, [STORY]);
  assert.equal(h.sent(STORY), 0);
  const input = { line: h.LINE, text: STORY, speech: h.target(fake.route, sourceId) };
  const duplicate = await h.rawSend(input);
  assert.match(JSON.stringify(duplicate), /duplicate/);
  assert.equal(fake.synthesized.length, 1);
  rejected(await h.rawSend({ ...input, text: 'Different story for the same source.' }), /different speech action/);
  rejected(await h.rawSend({ ...input, speech: h.target(fake.route, 'spoofed-source') }), /ended or changed/);
  rejected(await h.rawSend({ ...input, line: h.ELSEWHERE }), /ended or changed/);
  rejected(await h.rawSend(input, true), /scope|belong|authorized|access/i);
  h.report('typed story and target isolation', { spokenOnce: true, chatCopies: 0, duplicateReused: true, changedDuplicateRejected: true, spoofedSourceRejected: true, wrongLineRejected: true, otherOwnerRejected: true });
  return fake;
}

async function parallelInputs(fake: h.FakeCall): Promise<void> {
  h.chat('FIXTURE_DELEGATE run the fixture background task.');
  await h.until('worker running and held', () => h.upstream.held.has('worker') && h.activity.snapshot().workers > 0);
  await h.idle();
  h.chat('FIXTURE_CHAT_DURING_WORKER');
  hearSharedCall(fake.route, 'FIXTURE_VOICE answer while the worker and chat are active.', 'voice-parallel');
  await h.until('simultaneous chat and voice replies', () => h.sent('FIXTURE_CHAT_DURING_WORKER') === 1 && fake.frames.length === 2);
  assert.ok(h.activity.snapshot().workers > 0);
  h.upstream.release('worker');
  await h.until('worker finished', () => h.activity.snapshot().workers === 0 && h.activity.snapshot().tasks.some((task) => task.status === 'completed'));
  await h.idle();
  assert.deepEqual(fake.synthesized, [STORY, 'Voice fixture answer.']);
  h.report('voice chat worker concurrency', { chatWhileWorkerRuns: true, voiceWhileWorkerRuns: true, ordinaryChatSilent: true, workerOutputSilent: true, plainAssistantSilent: true });
}

async function untrustedSources(fake: h.FakeCall): Promise<void> {
  const total = fake.synthesized.length;
  const spoofed = h.chat('FIXTURE_CHAT_SPOOFED', h.LINE, h.FROM, { senderVerified: false });
  const otherCaller = h.chat('FIXTURE_CHAT_OTHER_CALLER', h.LINE, h.ALICE);
  await h.until('untrusted chat processed', () => h.sent('FIXTURE_CHAT_OTHER_CALLER') === 1);
  for (const sourceId of [spoofed, otherCaller])
    rejected(await h.rawSend({ line: h.LINE, text: 'Do not speak.', speech: h.target(fake.route, sourceId) }), /ended or changed/);
  const unauthorized = { ...fake.route, agentId: 'other000001' };
  assert.equal(openSharedCall(unauthorized, 'spoofed-open', { enqueue: () => { throw new Error('Unauthorized transport reached'); }, terminate: () => undefined }), false);
  assert.equal(fake.synthesized.length, total);
  h.report('authenticated source binding', { unsignedSenderRejected: true, otherCallerRejected: true, unauthorizedOpenRejected: true });
}

async function hangupBeforeReasoning(fake: h.FakeCall): Promise<void> {
  const session = h.agent.runner.id;
  h.chat('FIXTURE_HOLD_MAIN hold this chat response.');
  await h.until('held main reasoning', () => h.upstream.held.has('FIXTURE_HOLD_MAIN'));
  hearSharedCall(fake.route, 'FIXTURE_VOICE this queued call input must never run.', 'cancel-before');
  await h.until('queued voice', () => h.activity.snapshot().pending > 0);
  fake.end();
  h.chat('FIXTURE_CHAT_AFTER_QUEUED_HANGUP');
  h.upstream.release('FIXTURE_HOLD_MAIN');
  await h.until('chat after queued hangup', () => h.sent('FIXTURE_CHAT_AFTER_QUEUED_HANGUP') === 1);
  await h.idle();
  assert.equal(h.agent.runner.id, session);
  assert.ok(!h.upstream.seen.some((request) => request.text.includes('this queued call input must never run')));
  rejected(await h.rawSend({ line: h.LINE, text: 'Late speech.', speech: h.target(fake.route, 'cancel-before') }), /ended or changed/);
  h.report('hangup before call reasoning', { queuedVoiceCancelled: true, nextChatAnswered: true, sameSession: true, endedTargetRejected: true });
}

async function hangupDuringReasoning(): Promise<void> {
  const fake = await h.call();
  const session = h.agent.runner.id;
  hearSharedCall(fake.route, 'FIXTURE_HOLD_CALL finish after hangup.', 'cancel-during');
  await h.until('held call reasoning', () => h.upstream.held.has('FIXTURE_HOLD_CALL'));
  fake.end();
  h.chat('FIXTURE_CHAT_AFTER_REASONING_HANGUP');
  h.upstream.release('FIXTURE_HOLD_CALL');
  await h.until('chat after reasoning hangup', () => h.sent('FIXTURE_CHAT_AFTER_REASONING_HANGUP') === 1);
  await h.idle();
  assert.equal(h.agent.runner.id, session);
  assert.deepEqual(fake.synthesized, []);
  assert.equal(h.sent('Voice fixture answer.'), 0);
  h.report('hangup during call reasoning', { lateSpeechRejected: true, nextChatAnswered: true, sameSession: true });
}

async function replacement(): Promise<void> {
  const first = await h.call('fixture-reused-call-id');
  const second = await h.call('fixture-reused-call-id');
  rejected(await h.rawSend({ line: h.LINE, text: 'Stale generation.', speech: h.target(first.route, first.sourceId) }), /ended or changed/);
  hearSharedCall(first.route, 'FIXTURE_VOICE stale replacement transcript.', 'stale-heard');
  const id = h.chat('FIXTURE_STORY speak on the replacement only.');
  await h.until('replacement audio', () => second.frames.length === 1);
  assert.deepEqual(first.synthesized, []);
  assert.deepEqual(second.synthesized, [STORY]);
  assert.notEqual(first.route.generation, second.route.generation);
  assert.match(JSON.stringify(await h.rawSend({ line: h.LINE, text: STORY, speech: h.target(second.route, id) })), /duplicate/);
  second.end();
  first.queue.close();
  await h.idle();
  h.report('replacement call', { oldGenerationRejected: true, sameCallIdNewGeneration: true, exactReplacementSpokenOnce: true });
}

async function hangupApproval(): Promise<void> {
  const fake = await h.call();
  const session = h.agent.runner.id;
  h.policy('ask');
  h.chat('FIXTURE_APPROVAL ask for this call speech in a worker.');
  await h.until('SDK worker approval reaches daemon', () => h.pending().length > 0 && h.activity.snapshot().approvals > 0);
  const prompt = h.pending()[0];
  assert.ok(prompt);
  assert.match(prompt.preview, /"speech"/);
  assert.equal(prompt.line, h.LINE);
  fake.end();
  await h.until('hangup cancels pending approval', () => h.pending().length === 0 && h.activity.snapshot().approvals === 0);
  assert.equal(await answerPrompt(prompt.requestId, 'allow', 'chat'), undefined);
  h.policy('allow');
  h.chat('FIXTURE_CHAT_AFTER_APPROVAL_HANGUP');
  await h.until('chat after approval hangup', () => h.sent('FIXTURE_CHAT_AFTER_APPROVAL_HANGUP') === 1);
  await h.until('approval worker settled', () => h.activity.snapshot().workers === 0);
  await h.idle();
  assert.deepEqual(fake.synthesized, []);
  assert.equal(h.agent.runner.id, session);
  h.report('hangup during worker approval', { realSdkCanUseTool: true, pendingRevoked: true, lateApprovalRejected: true, nextChatAnswered: true, sameSession: true });
}

await h.authProof();
await h.boot();
try {
  h.chat('FIXTURE_CHAT_WARM');
  await h.until('warm chat', () => h.sent('FIXTURE_CHAT_WARM') === 1);
  await h.idle();
  const session = h.agent.runner.id;
  assert.ok(session);
  const fake = await typedStory();
  await parallelInputs(fake);
  await untrustedSources(fake);
  await hangupBeforeReasoning(fake);
  await hangupDuringReasoning();
  await replacement();
  await hangupApproval();
  await resumedCompaction();
  await reattach();
  await reconnect();
  assert.equal(h.agent.runner.id, session);
  assert.deepEqual(h.upstream.failures, []);
  h.report('shared SDK call fixture', { pass: true, session, fixture: h.ROOT, upstreamRequests: h.upstream.seen.length, realProviderRequests: 0, paidCost: 0 });
} finally {
  await h.close();
}
process.exit(0);
