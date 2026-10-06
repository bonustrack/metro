import { afterEach, expect, test } from 'bun:test';
import type { Playback } from '../src/voice/audio.ts';
import type { Heard } from '../src/voice/scribe.ts';
import { SharedTalk } from '../src/voice/shared-talk.ts';
import { SpeechQueue } from '../src/voice/speech-queue.ts';
import { FakeSpeech, pause, speechAction, voiceConfig } from './voice-shared-fixtures.ts';

const queues: SpeechQueue[] = [];
const talks: SharedTalk[] = [];

afterEach(() => {
  for (const talk of talks.splice(0)) talk.finish();
  for (const queue of queues.splice(0)) queue.close();
});

function fixture(send: Playback['send'] = () => undefined, timeoutMs = 1000): { queue: SpeechQueue; speech: FakeSpeech[] } {
  const speech: FakeSpeech[] = [];
  const queue = new SpeechQueue(voiceConfig, send, (failed) => {
    const fake = new FakeSpeech(failed);
    speech.push(fake);
    return fake;
  }, timeoutMs);
  queues.push(queue);
  return { queue, speech };
}

test('accepted speech waits for connection and for transport drain before completed', async () => {
  const sent = Promise.withResolvers<void>();
  const { queue, speech } = fixture(() => sent.promise);
  const { action, statuses } = speechAction();
  expect(queue.enqueue(action)).toBe(true);
  await pause();
  expect(speech).toHaveLength(0);
  queue.connect();
  expect(speech[0]?.words).toEqual([action.text]);
  speech[0]?.audio();
  speech[0]?.done();
  await pause(40);
  expect(statuses).toEqual([]);
  sent.resolve();
  await pause();
  expect(statuses).toEqual(['started', 'completed']);
  speech[0]?.done();
  speech[0]?.failed('late provider failure');
  expect(statuses).toEqual(['started', 'completed']);
});

test('the independent TTS queue is serial and cancellation drops current and pending audio', async () => {
  const { queue, speech } = fixture();
  const a = speechAction('a');
  const b = speechAction('b');
  queue.enqueue(a.action);
  queue.enqueue(b.action);
  queue.connect();
  expect(speech).toHaveLength(1);
  speech[0]?.audio();
  speech[0]?.done();
  await pause(50);
  expect(a.statuses).toEqual(['started', 'completed']);
  expect(speech).toHaveLength(2);
  speech[1]?.audio(10);
  const c = speechAction('c');
  queue.enqueue(c.action);
  queue.cancel();
  expect(b.statuses.at(-1)).toBe('interrupted');
  expect(c.statuses).toEqual(['interrupted']);
  speech[1]?.done();
  speech[1]?.audio();
  await pause(30);
  expect(speech).toHaveLength(2);
  expect(b.statuses.filter((status) => status === 'interrupted')).toHaveLength(1);
  expect(b.statuses).not.toContain('completed');
});

test('speech is revalidated before synthesis, each audio chunk and each frame delivery', async () => {
  let valid = true;
  let failures = 0;
  const { queue, speech } = fixture();
  queue.whenFailed(() => { failures += 1; });
  const a = speechAction('a', () => valid);
  queue.enqueue(a.action);
  valid = false;
  queue.connect();
  expect(a.statuses).toEqual(['failed']);
  expect(speech).toHaveLength(0);
  valid = true;
  const b = speechAction('b', () => valid);
  queue.enqueue(b.action);
  await pause();
  valid = false;
  speech[0]?.audio();
  expect(b.statuses).toEqual(['failed']);
  valid = true;
  const c = speechAction('c', () => valid);
  queue.enqueue(c.action);
  await pause();
  speech[1]?.audio();
  speech[1]?.done();
  valid = false;
  await pause(40);
  expect(c.statuses).toEqual(['failed']);
  expect(failures).toBe(0);
});

test('bounded queues reject overflow and a provider timeout or oversized PCM fails once', async () => {
  const { queue } = fixture();
  const actions = Array.from({ length: 8 }, (_, index) => speechAction(String(index)));
  for (const { action } of actions) expect(queue.enqueue(action)).toBe(true);
  expect(queue.enqueue(speechAction('overflow').action)).toBe(false);
  queue.cancel();
  for (const { statuses } of actions) expect(statuses).toEqual(['interrupted']);
  const timed = fixture(() => undefined, 10);
  const timeout = speechAction('timeout');
  timed.queue.enqueue(timeout.action);
  timed.queue.connect();
  await pause(30);
  expect(timeout.statuses).toEqual(['failed']);
  timed.speech[0]?.done();
  expect(timeout.statuses).toEqual(['failed']);
  const largeFixture = fixture();
  const overflow = speechAction('pcm');
  largeFixture.queue.enqueue(overflow.action);
  largeFixture.queue.connect();
  largeFixture.speech[0]?.audio(3001);
  expect(overflow.statuses).toEqual(['failed']);
});

test('provider and transport failures are failed, never completed', async () => {
  const provider = fixture();
  const a = speechAction('provider');
  provider.queue.enqueue(a.action);
  provider.queue.connect();
  provider.speech[0]?.audio();
  provider.speech[0]?.failed('provider failed after partial audio');
  provider.speech[0]?.done();
  expect(a.statuses).toEqual(['failed']);
  const transport = fixture(() => Promise.reject(new Error('fake transport unavailable')));
  const b = speechAction('transport');
  transport.queue.enqueue(b.action);
  transport.queue.connect();
  transport.speech[0]?.audio();
  transport.speech[0]?.done();
  await pause(35);
  expect(b.statuses).toEqual(['failed']);
});

test('barge-in interrupts playback only, STT commits retain the conversation, hangup drops late callbacks', async () => {
  const { queue, speech } = fixture();
  let heard: Heard = { partial: () => undefined, committed: () => undefined, failed: () => undefined };
  let closed = 0;
  const inputs: { text: string; sourceId: string }[] = [];
  const ended: string[] = [];
  const talk = new SharedTalk(voiceConfig, () => undefined, (reason) => ended.push(reason), (text, sourceId) => inputs.push({ text, sourceId }), (events) => {
    heard = events;
    return { send: () => undefined, close: () => { closed += 1; } };
  }, queue);
  talks.push(talk);
  const a = speechAction();
  talk.enqueue(a.action);
  talk.connect();
  heard.partial('hello there');
  expect(a.statuses).toEqual([]);
  speech[0]?.audio(100);
  heard.partial('okay');
  expect(a.statuses).toEqual([]);
  heard.partial('hold on');
  expect(a.statuses).toEqual(['interrupted']);
  expect(inputs).toEqual([]);
  heard.committed('Continue the same story');
  expect(inputs[0]?.text).toBe('Continue the same story');
  expect(inputs[0]?.sourceId).toMatch(/^[\da-f-]{36}$/);
  heard.committed('And another sentence');
  expect(inputs[1]?.sourceId).not.toBe(inputs[0]?.sourceId);
  talk.finish();
  talk.finish();
  heard.committed('late words');
  heard.failed('late error');
  speech[0]?.audio();
  speech[0]?.done();
  await pause();
  expect(inputs).toHaveLength(2);
  expect(ended).toEqual([]);
  expect(closed).toBe(1);
  expect(talk.enqueue(speechAction('late').action)).toBe(false);
});
