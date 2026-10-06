import { expect, test } from 'bun:test';
import { isRecord } from '@metro-labs/core/is-record';
import { Call } from '../src/voice/call.ts';
import { callStart, FakeCall, pause, voiceConfig } from './voice-shared-fixtures.ts';

function signalOf(fixture: FakeCall, kind: string): Record<string, unknown> | undefined {
  return fixture.calls.map((call) => call.args.signal).find((value): value is Record<string, unknown> => isRecord(value) && value.kind === kind);
}

function offer(call: Call, fixture: FakeCall): void {
  call.signalled({ kind: 'offer', from: callStart.callerPeer, to: signalOf(fixture, 'join')?.from, callId: callStart.callId, sdp: 'fake-offer' });
}

test('SDK calls open the existing conversation without a Brain or recent chat read', async () => {
  const fixture = new FakeCall();
  const call = new Call(callStart, voiceConfig, () => undefined, fixture.deps);
  await call.begin();
  await call.begin();
  expect(fixture.events).toEqual(['shared']);
  expect(fixture.calls.map((row) => row.action)).toEqual(['callSignal']);
  expect(fixture.routes).toEqual([call.route]);
  expect(call.route).toMatchObject({ agentId: callStart.agentId, line: callStart.line, from: callStart.from, callId: callStart.callId });
  expect(call.route.generation).toMatch(/^[\da-f-]{36}$/);
  fixture.heard('My committed words', 'stt-a');
  expect(fixture.inputs).toEqual([{ route: call.route, text: 'My committed words', sourceId: 'stt-a' }]);
  await call.leave('the caller hung up');
  expect(fixture.calls.some((row) => row.action === 'send')).toBe(false);
});

test('an unavailable SDK conversation fails closed without falling back to CLI', async () => {
  const fixture = new FakeCall();
  fixture.available = false;
  const call = new Call(callStart, voiceConfig, () => undefined, fixture.deps);
  await expect(call.begin()).rejects.toThrow('shared conversation is unavailable');
  await call.leave('starting failed');
  expect(fixture.events).not.toContain('cli');
  expect(signalOf(fixture, 'join')).toBeUndefined();
  expect(fixture.calls.some((row) => row.action === 'read' || row.action === 'send')).toBe(false);
});

test('hangup closes local resources and frees the slot before a stuck leave, once only', async () => {
  const fixture = new FakeCall();
  const answer = Promise.withResolvers<string>();
  fixture.answer = () => answer.promise;
  const call = new Call(callStart, voiceConfig, () => { fixture.events.push('over'); }, fixture.deps);
  await call.begin();
  offer(call, fixture);
  fixture.peer.state('connected');
  fixture.signal = () => new Promise(() => undefined);
  const started = Date.now();
  call.hangUp('the caller hung up');
  expect(fixture.events).toEqual(['shared', 'connect', 'finish', 'peer-close', 'ended', 'over']);
  call.hangUp('duplicate hangup');
  fixture.peer.state('connected');
  fixture.peer.audio(Buffer.alloc(1));
  fixture.heard('late STT', 'late');
  answer.resolve('late answer');
  await call.leave('another duplicate');
  expect(Date.now() - started).toBeLessThan(500);
  expect(fixture.events).toEqual(['shared', 'connect', 'finish', 'peer-close', 'ended', 'over']);
  expect(fixture.inputs).toEqual([]);
  expect(signalOf(fixture, 'answer')).toBeUndefined();
});

test('a join completing after hangup never rearms the call and leaves again', async () => {
  const fixture = new FakeCall();
  const joined = Promise.withResolvers<void>();
  fixture.signal = (args) => isRecord(args.signal) && args.signal.kind === 'join' ? joined.promise : Promise.resolve();
  const call = new Call(callStart, voiceConfig, () => { fixture.events.push('over'); }, fixture.deps);
  const starting = call.begin();
  call.hangUp('the caller hung up');
  joined.resolve();
  await starting;
  await call.leave('duplicate');
  expect(fixture.events.filter((row) => row === 'over')).toHaveLength(1);
  expect(fixture.calls.filter((row) => isRecord(row.args.signal) && row.args.signal.kind === 'leave')).toHaveLength(2);
});

test('late callbacks from an old call cannot change its replacement route', async () => {
  const oldFixture = new FakeCall();
  const old = new Call(callStart, voiceConfig, () => undefined, oldFixture.deps);
  await old.begin();
  const leaving = old.leave('the caller started a new call');
  const nextFixture = new FakeCall();
  const next = new Call(callStart, voiceConfig, () => undefined, nextFixture.deps);
  await next.begin();
  expect(next.route.generation).not.toBe(old.route.generation);
  oldFixture.heard('stale words', 'stale');
  oldFixture.peer.state('closed');
  expect(oldFixture.inputs).toEqual([]);
  expect(nextFixture.events).toEqual(['shared']);
  await leaving;
  await next.leave('the caller hung up');
});

test('CLI calls retain their own Brain context path without the SDK seam', async () => {
  const fixture = new FakeCall();
  fixture.selected = false;
  const call = new Call(callStart, voiceConfig, () => undefined, fixture.deps);
  await call.begin();
  await pause();
  expect(fixture.routes).toEqual([]);
  expect(fixture.events).toEqual(['cli', 'prime']);
  expect(fixture.calls.filter((row) => row.action === 'read')).toHaveLength(1);
  await call.leave('the caller hung up');
  expect(fixture.events).not.toContain('ended');
  expect(fixture.events.filter((row) => row === 'finish')).toHaveLength(1);
});
