import assert from 'node:assert/strict';
import { hearSharedCall, sharedCalls } from '../../apps/daemon/src/voice/shared.js';
import { runnerEnv } from '../../packages/sdk-runner/src/runner.js';
import * as h from './shared-call-harness.js';
import { HUMAN, LatencyModel, WORKLOAD, type RequestTiming } from './shared-call-latency-model.js';
import { check, checks, inputOf, inputs, save, submit, timing, toolEvents } from './shared-call-latency-metrics.js';

const model = new LatencyModel(h.LINE);
h.upstream.script = (request) => model.reply(request);
h.delays.write = WORKLOAD.writeMs;
h.delays.speech = WORKLOAD.speechMs;
const measure = process.argv.includes('--measure');
const after = async (at: number, task: () => Promise<unknown> | void): Promise<void> => { await Bun.sleep(Math.max(0, at - Date.now())); await task(); };

async function pressure(fake: h.FakeCall): Promise<void> {
  h.chat('LATENCY_LAUNCH Start five background fixture workers.');
  await h.until('five actual SDK workers held', () => model.workers.size === 5 && h.activity.snapshot().workers === 5, 60_000);
  await h.idle();
  h.chat('LATENCY_PRESSURE Complete the five fixed writes while handling incoming human requests.');
  await h.until('first delayed real MCP write', () => h.sent('LATENCY_LOOP_1') === 1);
  const start = h.train.find((row) => row.args.text === 'LATENCY_LOOP_1')?.at;
  assert.ok(start);
  const arrivals = HUMAN.map((marker, index) => after(start + WORKLOAD.humanOffsets[index], async () => {
    await submit(marker, index === 0 ? 'call' : 'chat', () => {
      if (index !== 0) return h.chat(`${marker} ${index === 2 ? 'Speak this answer in our active call only.' : 'Answer this ordinary typed chat in chat only.'}`);
      hearSharedCall(fake.route, `${marker} Please answer this voice question.`, marker);
      return marker;
    });
  }));
  await Promise.all([...arrivals, ...WORKLOAD.workerOffsets.map((offset, id) => after(start + offset, () => { model.releaseWorker(id); }))]);
  await h.until('pressure replies and complete fixed work', () => fake.audio.length === 2 && h.sent('LATENCY_HUMAN_CHAT_REPLY') === 1
    && h.train.filter((row) => String(row.args.text).startsWith('LATENCY_LOOP_') && row.completedAt !== null).length === WORKLOAD.loopWrites
    && h.activity.snapshot().workers === 0, 90_000);
  await h.idle();
  const rows = inputs.filter((row) => HUMAN.some((marker) => marker === row.marker)).map((row) => timing(row, model, fake));
  for (const row of rows) h.report('latency human timing', row);
  const waits = rows.map((row) => row.acceptedToConsumedMs);
  check('first human consumed within six seconds', typeof waits[0] === 'number' && waits[0] <= 6_000, waits[0], 6_000);
  check('all humans consumed within fourteen seconds', waits.every((wait) => typeof wait === 'number' && wait <= 14_000), waits, 14_000);
  for (const row of rows.filter((value) => value.marker !== 'LATENCY_HUMAN_CHAT')) check(`${String(row.marker)} provider to audio`, typeof row.providerToAudioMs === 'number' && row.providerToAudioMs <= 4_000, row.providerToAudioMs, 4_000);
  const notifications = h.timedEvents.filter(({ message }) => message.type === 'system' && message.subtype === 'task_notification' && message.status === 'completed');
  check('five actual SDK completion notifications', notifications.length === 5, notifications);
  check('fixed five writes preserved', h.train.filter((row) => String(row.args.text).startsWith('LATENCY_LOOP_')).length === 5, h.train.filter((row) => String(row.args.text).startsWith('LATENCY_LOOP_')));
  check('only explicit speech produced audio', fake.synthesized.length === 2 && fake.synthesized.every((text) => text === 'LATENCY_HUMAN_VOICE_REPLY' || text === 'LATENCY_HUMAN_SPEAK_REPLY'), fake.synthesized);
  check('speech has no chat copies', h.sent('LATENCY_HUMAN_VOICE_REPLY') === 0 && h.sent('LATENCY_HUMAN_SPEAK_REPLY') === 0, h.train.map((row) => row.args.text));
}

function nudges(requests: RequestTiming[]): number {
  const counts = requests.map((row) => row.text.split('[Your previous response had no visible output.').length - 1);
  return counts.slice(1).reduce((sum, count, index) => sum + Math.max(0, count - counts[index]), 0);
}

async function emptyTurns(fake: h.FakeCall): Promise<void> {
  const start = model.requests.length;
  const ingress = await submit('LATENCY_SILENT', 'chat', () => h.chat('LATENCY_SILENT Speak this response in the active call only.'));
  await h.until('successful silent speech audio', () => fake.audio.some((row) => row.text === 'LATENCY_SILENT_REPLY'));
  await h.idle();
  const requests = model.requests.slice(start);
  h.report('silent speech timings', timing(ingress, model, fake));
  h.report('silent speech provider sequence', { requests });
  check('successful silent speech has no visibility reprompt', requests.length === 2 && nudges(requests) === 0, { count: requests.length, nudges: nudges(requests), requests });
  check('successful silent speech happens once without chat', fake.synthesized.filter((text) => text === 'LATENCY_SILENT_REPLY').length === 1 && h.sent('LATENCY_SILENT_REPLY') === 0, fake.synthesized);
  for (const mode of ['empty', 'read']) {
    const from = model.requests.length;
    h.chat(`LATENCY_CONTROL_${mode.toUpperCase()}`);
    await h.until(`${mode} control reached provider`, () => model.requests.length > from);
    await h.idle();
    const sequence = model.requests.slice(from);
    h.report('empty-turn negative control', { mode, requests: sequence });
    check(`${mode} still triggers visibility reprompt`, sequence.length === (mode === 'read' ? 3 : 2) && nudges(sequence) === 1, sequence);
    if (mode === 'read') {
      const read = toolEvents('mcp__metro__list_accounts', 'name');
      check('read control used a successful real tool', read.length === 1 && read[0].resultAt !== null && !JSON.stringify(read[0].result).includes('"is_error":true'), read);
    }
  }
}

async function hangup(fake: h.FakeCall): Promise<void> {
  const runner = h.agent.runner;
  const session = runner.id;
  h.chat('LATENCY_HOLD_RACE Begin a delayed foreground write.');
  await h.until('hangup race foreground write running', () => h.train.some((row) => row.args.text === 'LATENCY_RACE_WRITE' && row.completedAt === null));
  const typed = await submit('LATENCY_RACE', 'chat', () => h.chat('LATENCY_RACE Speak this typed request in our active call.'));
  const queued = await submit('LATENCY_CANCELLED', 'call', () => {
    hearSharedCall(fake.route, 'LATENCY_CANCELLED Never answer this queued call input after hangup.', 'LATENCY_CANCELLED');
    return 'LATENCY_CANCELLED';
  });
  const staged = { ...inputOf(typed.id) };
  const write = h.train.find((row) => row.args.text === 'LATENCY_RACE_WRITE');
  assert.ok(write);
  assert.notEqual(staged.dispatchedAt, null);
  assert.equal(staged.consumedAt, null);
  assert.equal(write.completedAt, null);
  assert.equal(inputOf(queued.id).dispatchedAt, null);
  const endAt = Date.now();
  fake.end();
  assert.equal(sharedCalls.valid({ route: fake.route, sourceId: typed.sourceId }), false);
  assert.equal(sharedCalls.valid({ route: fake.route, sourceId: queued.sourceId }), false);
  assert.notEqual(inputOf(typed.id).state, 'cancelled');
  await h.until('queued call input cancelled at hangup', () => inputOf(queued.id).state === 'cancelled');
  await h.until('stale typed speech reaches real tool check', () => toolEvents('LATENCY_RACE_REPLY').some((row) => row.resultAt !== null));
  await h.idle();
  const result = toolEvents('LATENCY_RACE_REPLY');
  const consumedAt = inputOf(typed.id).consumedAt;
  assert.ok(write.completedAt !== null && consumedAt !== null && staged.dispatchedAt !== null);
  assert.ok(write.at <= staged.dispatchedAt && staged.dispatchedAt < write.completedAt);
  assert.ok(endAt < write.completedAt && consumedAt >= write.completedAt);
  assert.equal(h.sent('LATENCY_RACE_WRITE'), 1);
  assert.equal(inputOf(queued.id).consumedAt, null);
  assert.equal(h.sent('LATENCY_RACE_REPLY'), 0);
  h.report('hangup race timings', { endAt, staged, write, authorityRevoked: true, chatCopies: h.sent('LATENCY_RACE_REPLY'), typed: timing(typed, model, fake), queued: inputOf(queued.id), result });
  check('typed hangup race produces no stale audio', !fake.synthesis.some((row) => row.at >= endAt) && !fake.audio.some((row) => row.at >= endAt), fake.audio);
  check('stale speech tool was refused', result.length === 1 && JSON.stringify(result[0].result).includes('"is_error":true'), result);
  check('queued call never reaches provider', !model.requests.some((row) => row.text.includes('LATENCY_CANCELLED')), inputOf(queued.id));
  check('same runner session survives hangup', h.agent.runner === runner && runner.id === session, { before: session, after: runner.id });
}

async function refusedTurn(fake: h.FakeCall): Promise<void> {
  const start = model.requests.length;
  const synthesis = fake.synthesis.length;
  const audio = fake.audio.length;
  h.chat('LATENCY_CONTROL_REFUSED Retry the exact expired speech target as a refusal-only fixture control.');
  await h.until('fresh refused send reaches real daemon check', () => toolEvents('LATENCY_REFUSED_REPLY').some((row) => row.resultAt !== null));
  await h.idle();
  const result = toolEvents('LATENCY_REFUSED_REPLY');
  const expired = inputs.find((row) => row.marker === 'LATENCY_RACE');
  assert.ok(expired);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].input.speech, h.target(fake.route, expired.sourceId));
  assert.match(JSON.stringify(result[0].result), /"is_error":true/);
  assert.match(JSON.stringify(result[0].result), /ended or changed/);
  assert.equal(fake.synthesis.length, synthesis);
  assert.equal(fake.audio.length, audio);
  assert.equal(h.sent('LATENCY_REFUSED_REPLY'), 0);
  const requests = model.requests.slice(start);
  h.report('fresh refused-send-only control', { requests, result, lateSynthesis: 0, lateAudio: 0, chatCopies: 0 });
  check('failed send still triggers visibility reprompt', requests.length === 3 && requests.every((row) => row.kind.startsWith('refused-')) && nudges(requests) === 1, requests);
}

try {
  h.report('latency workload', { workload: WORKLOAD, measure, sdk: '0.3.287', terminalTools: runnerEnv({}).CLAUDE_CODE_TERMINAL_MCP_TOOLS ?? null });
  await h.boot();
  const fake = await h.call('fixture-latency');
  await pressure(fake);
  await emptyTurns(fake);
  await hangup(fake);
  await refusedTurn(fake);
  assert.deepEqual(h.upstream.failures, []);
  h.report('latency fixture result', { pass: checks.every((row) => row.pass), failed: checks.filter((row) => !row.pass).map((row) => row.name), evidence: save(model), session: h.agent.runner.id, upstreamRequests: h.upstream.seen.length, realProviderRequests: 0, paidCost: 0 });
  if (!measure) assert.ok(checks.every((row) => row.pass), 'Latency regression checks must all pass');
} catch (err) {
  h.report('latency fixture failure', { error: String(err), evidence: save(model) });
  throw err;
} finally {
  await h.close();
}
