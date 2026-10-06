import { afterAll, afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { isRecord } from '@metro-labs/core/is-record';
import { log } from '@metro-labs/core/log';
import type { Playback } from '../src/voice/audio.ts';
import { SpeechQueue } from '../src/voice/speech-queue.ts';
import { FakeSpeech, pause, speechAction, voiceConfig } from './voice-shared-fixtures.ts';

const queues: SpeechQueue[] = [];
const logs = spyOn(log, 'info');

function timings(): unknown[] {
  return logs.mock.calls.filter(([, message]) => message === 'voice: speech timing').map(([entry]) => entry);
}

beforeEach(() => { logs.mockClear(); });
afterAll(() => { logs.mockRestore(); });
afterEach(() => {
  for (const queue of queues.splice(0)) queue.close();
});

function fixture(send: Playback['send'] = () => Promise.resolve()): { queue: SpeechQueue; speech: FakeSpeech[] } {
  const speech: FakeSpeech[] = [];
  const queue = new SpeechQueue(voiceConfig, send, (failed) => {
    const fake = new FakeSpeech(failed);
    speech.push(fake);
    return fake;
  });
  queues.push(queue);
  return { queue, speech };
}

test('speech timings separate first PCM from marked send resolution and never log words', async () => {
  const transport = Promise.withResolvers<void>();
  const { queue, speech } = fixture((_opus, _timestamp, marker) => marker ? transport.promise : Promise.resolve());
  const { action } = speechAction('timed-action');
  const queuedAt = Date.now();
  queue.enqueue(action);
  await pause();
  const synthesisAt = Date.now();
  queue.connect();
  speech[0]?.audio(0);
  await pause();
  const firstAudioAt = Date.now();
  speech[0]?.audio();
  speech[0]?.done();
  await pause(35);
  expect(timings()).toEqual([]);
  const markedFrameResolvedAt = Date.now();
  transport.resolve();
  await pause();
  const expected = {
    actionId: action.actionId, status: 'completed',
    queuedAt: expect.any(Number), synthesisStartedAt: expect.any(Number),
    firstAudioAt: expect.any(Number), markedFrameResolvedAt: expect.any(Number), settledAt: expect.any(Number),
  };
  expect(timings()).toEqual([expected]);
  const recorded = timings()[0];
  if (!isRecord(recorded)) throw new Error('missing speech timing');
  expect(recorded.queuedAt).toBeGreaterThanOrEqual(queuedAt);
  expect(recorded.queuedAt).toBeLessThanOrEqual(synthesisAt);
  expect(recorded.synthesisStartedAt).toBeGreaterThanOrEqual(synthesisAt);
  expect(recorded.synthesisStartedAt).toBeLessThanOrEqual(firstAudioAt);
  expect(recorded.firstAudioAt).toBeGreaterThanOrEqual(firstAudioAt);
  expect(recorded.firstAudioAt).toBeLessThanOrEqual(markedFrameResolvedAt);
  expect(recorded.markedFrameResolvedAt).toBeGreaterThanOrEqual(markedFrameResolvedAt);
  expect(recorded.markedFrameResolvedAt).toBeLessThanOrEqual(Date.now());
  expect(JSON.stringify(timings())).not.toContain(action.text);
  speech[0]?.audio();
  speech[0]?.done();
  speech[0]?.failed('late');
  expect(timings()).toHaveLength(1);
});

test('queued cancellation records no synthesis, audio or transport timestamps', () => {
  const { queue } = fixture();
  queue.enqueue(speechAction('pending').action);
  queue.cancel();
  queue.close();
  expect(timings()).toEqual([{
    actionId: 'pending', status: 'interrupted', queuedAt: expect.any(Number),
    synthesisStartedAt: null, firstAudioAt: null, markedFrameResolvedAt: null, settledAt: expect.any(Number),
  }]);
});

test('a rejected speech send retains first audio but no marked-frame resolution', async () => {
  let markedSent = false;
  const { queue, speech } = fixture((_opus, _timestamp, marker) => {
    if (!marker) return Promise.resolve();
    markedSent = true;
    return Promise.reject(new Error('failed speech send'));
  });
  queue.enqueue(speechAction('failed-transport').action);
  queue.connect();
  await pause();
  expect(timings()).toEqual([]);
  speech[0]?.audio();
  speech[0]?.done();
  await pause(40);
  expect(markedSent).toBe(true);
  expect(timings()).toEqual([{
    actionId: 'failed-transport', status: 'failed', queuedAt: expect.any(Number),
    synthesisStartedAt: expect.any(Number), firstAudioAt: expect.any(Number), markedFrameResolvedAt: null, settledAt: expect.any(Number),
  }]);
});

test('a later unmarked send resolution does not stand in for the pending marked frame', async () => {
  const marked = Promise.withResolvers<void>();
  const later = Promise.withResolvers<void>();
  let markedSent = false;
  const { queue, speech } = fixture((_opus, _timestamp, marker) => {
    if (marker) {
      markedSent = true;
      return marked.promise;
    }
    if (markedSent) later.resolve();
    return Promise.resolve();
  });
  queue.enqueue(speechAction('out-of-order').action);
  queue.connect();
  speech[0]?.audio(2);
  speech[0]?.done();
  await later.promise;
  await pause();
  expect(timings()).toEqual([]);
  queue.cancel();
  expect(timings()).toEqual([{
    actionId: 'out-of-order', status: 'interrupted', queuedAt: expect.any(Number),
    synthesisStartedAt: expect.any(Number), firstAudioAt: expect.any(Number), markedFrameResolvedAt: null, settledAt: expect.any(Number),
  }]);
  marked.resolve();
  await pause();
  expect(timings()).toHaveLength(1);
});

test('first PCM receipt is observed before authorization rejects forwarding', async () => {
  let valid = true;
  let markedSent = false;
  const { queue, speech } = fixture((_opus, _timestamp, marker) => {
    markedSent ||= marker;
    return Promise.resolve();
  });
  const { action, statuses } = speechAction('revoked-before-audio', () => valid);
  queue.enqueue(action);
  queue.connect();
  valid = false;
  speech[0]?.audio();
  await pause(30);
  expect(markedSent).toBe(false);
  expect(statuses).toEqual(['failed']);
  expect(timings()).toEqual([{
    actionId: action.actionId, status: 'failed', queuedAt: expect.any(Number),
    synthesisStartedAt: expect.any(Number), firstAudioAt: expect.any(Number), markedFrameResolvedAt: null, settledAt: expect.any(Number),
  }]);
  speech[0]?.audio();
  expect(timings()).toHaveLength(1);
});
