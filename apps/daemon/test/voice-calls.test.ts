import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTrainCallBackend } from '../src/stations/train-call.ts';
import { leaveLeftoverCalls, onCallEvent } from '../src/voice/calls.ts';

const saved = process.env.METRO_AGENTS_DIR;
const line = 'metro://xmtp/acct/conv1';
let calls: { action: string; args: Record<string, unknown> }[] = [];
let leftovers: unknown[] = [];

beforeAll(() => {
  process.env.METRO_AGENTS_DIR = mkdtempSync(join(tmpdir(), 'metro-voice-calls-'));
});

afterAll(() => {
  if (saved === undefined) delete process.env.METRO_AGENTS_DIR;
  else process.env.METRO_AGENTS_DIR = saved;
});

beforeEach(() => {
  calls = [];
  leftovers = [];
  setTrainCallBackend(async (_train, action, args) => {
    const record = args as Record<string, unknown>;
    calls.push({ action, args: record });
    if (action === 'callLeftovers') return { result: { calls: leftovers } };
    if (record.line === 'metro://xmtp/acct/gone') return { error: 'conversation not found' };
    return { result: { messageId: 'm' } };
  });
});

const invite = (ageMs: number): void => {
  onCallEvent({
    line,
    from: 'metro://xmtp/acct/user/caller',
    ts: new Date(Date.now() - ageMs).toISOString(),
    payload: { contentType: 'callInvite', call: { callId: 'call-1', from: 'caller-peer', video: false } },
  });
};

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 10));

test('a ringing call the box cannot take is declined at once', async () => {
  invite(1_000);
  await settle();
  expect(calls).toEqual([{ action: 'callSignal', args: { line, signal: { kind: 'decline', callId: 'call-1' } } }]);
});

test('an invite the caller stopped ringing is left alone', async () => {
  invite(50_000);
  await settle();
  expect(calls).toEqual([]);
});

test('every call this box joined and never left is left at start', async () => {
  leftovers = [
    { line, callId: 'call-1', peer: 'peer-a' },
    { line: 'metro://xmtp/acct/gone', callId: 'call-2', peer: 'peer-b' },
    { line, callId: 'call-3', peer: 'peer-c' },
    { line, callId: '', peer: 'peer-d' },
  ];
  expect(await leaveLeftoverCalls()).toBe(2);
  expect(calls.filter((c) => c.action === 'callSignal').map((c) => c.args)).toEqual([
    { line, signal: { kind: 'leave', callId: 'call-1', from: 'peer-a' } },
    { line: 'metro://xmtp/acct/gone', signal: { kind: 'leave', callId: 'call-2', from: 'peer-b' } },
    { line, signal: { kind: 'leave', callId: 'call-3', from: 'peer-c' } },
  ]);
});
