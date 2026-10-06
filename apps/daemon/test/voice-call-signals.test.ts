import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TrainEvent } from '@metro-labs/core/trains/protocol';
import { setAgentMap, setAllowlistMap, setApproversMap, setDisabledAccounts } from '../src/agents/map.ts';
import { setTrainCallBackend } from '../src/stations/train-call.ts';
import type { CallStart } from '../src/voice/call.ts';
import { leaveCallsForShutdown, onCallEvent } from '../src/voice/calls.ts';
import { writeVoice } from '../src/voice/store.ts';
import { voiceConfig } from './voice-shared-fixtures.ts';

const saved = process.env.METRO_AGENTS_DIR;
const dir = mkdtempSync(join(tmpdir(), 'metro-voice-signals-'));
const line = 'metro://xmtp/account/chat';
const from = 'metro://xmtp/account/user/owner';
let sequence = 0;
let made: ReturnType<typeof create>[] = [];

beforeAll(() => { process.env.METRO_AGENTS_DIR = dir; });
afterAll(() => {
  if (saved === undefined) delete process.env.METRO_AGENTS_DIR;
  else process.env.METRO_AGENTS_DIR = saved;
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  made = [];
  setAgentMap({ 'xmtp/account': 'agent-a' }, {});
  setApproversMap({ 'xmtp/account': ['owner'] });
  setAllowlistMap({ 'xmtp/account': ['owner'] });
  setDisabledAccounts(new Set());
  writeVoice(voiceConfig);
  setTrainCallBackend(() => Promise.resolve({ result: {} }));
});
afterEach(async () => {
  await leaveCallsForShutdown();
  setAgentMap({}, {});
  setApproversMap({});
  setAllowlistMap({});
  setDisabledAccounts(new Set());
});

function create(start: CallStart, _cfg: unknown, onOver: () => void) {
  const signals: Record<string, unknown>[] = [];
  let hangs = 0;
  const call = {
    start, signals, onOver,
    get hangs() { return hangs; },
    begin: () => Promise.resolve(),
    hangUp: () => { hangs += 1; onOver(); },
    leave: () => { hangs += 1; onOver(); return Promise.resolve(); },
    signalled: (signal: Record<string, unknown>) => { signals.push(signal); },
  };
  made.push(call);
  return call;
}

function invite(changes: Partial<TrainEvent> = {}): TrainEvent {
  sequence += 1;
  return {
    station: 'xmtp', line, from, message_id: `source-${String(sequence)}`, ts: new Date().toISOString(),
    payload: { contentType: 'callInvite', call: { callId: `call-${String(sequence)}`, from: 'peer', video: false } },
    ...changes,
  };
}

function signal(changes: Partial<TrainEvent> = {}): TrainEvent {
  return {
    station: 'xmtp', line, from,
    payload: { contentType: 'callSignal', call: { kind: 'leave', callId: made[0]?.start.callId, from: 'peer' } },
    ...changes,
  };
}

test('only the exact authenticated network caller can signal its call', () => {
  const env = invite();
  onCallEvent(env, 'xmtp', create);
  expect(made).toHaveLength(1);
  expect(made[0]?.start.sourceId).toBe(env.message_id);
  expect(made[0]?.start.agentId).toBe('agent-a');
  onCallEvent(signal({ from: 'metro://xmtp/account/user/other' }));
  onCallEvent(signal({ line: 'metro://xmtp/account/other' }));
  onCallEvent(signal({ sender_verified: false }));
  onCallEvent(signal(), 'telegram');
  expect(made[0]?.signals).toEqual([]);
  onCallEvent(signal());
  expect(made[0]?.signals).toHaveLength(1);
});

test('forged station, account or unverified invites never open audio', () => {
  onCallEvent(invite(), 'telegram', create);
  onCallEvent(invite({ station: 'telegram' }), 'xmtp', create);
  onCallEvent(invite({ from: 'metro://xmtp/other/user/owner' }), 'xmtp', create);
  onCallEvent(invite({ sender_verified: false }), 'xmtp', create);
  onCallEvent(invite({ ts: new Date(Date.now() + 60_000).toISOString() }), 'xmtp', create);
  expect(made).toEqual([]);
});

test('duplicate invites are idempotent and replaced call callbacks do not clear a new call', () => {
  const oldInvite = invite();
  onCallEvent(oldInvite, 'xmtp', create);
  onCallEvent(oldInvite, 'xmtp', create);
  const nextInvite = invite();
  onCallEvent(nextInvite, 'xmtp', create);
  expect(made).toHaveLength(2);
  expect(made[0]?.hangs).toBe(1);
  made[0]?.onOver();
  onCallEvent(signal());
  expect(made[0]?.signals).toEqual([]);
  expect(made[1]?.signals).toHaveLength(1);
  made[1]?.hangUp();
  onCallEvent(oldInvite, 'xmtp', create);
  onCallEvent(nextInvite, 'xmtp', create);
  expect(made).toHaveLength(2);
});

test('off, unscoped or removed approver accounts never open a shared call', () => {
  setDisabledAccounts(new Set(['xmtp/account']));
  onCallEvent(invite(), 'xmtp', create);
  setDisabledAccounts(new Set());
  setAgentMap({}, {});
  onCallEvent(invite(), 'xmtp', create);
  setAgentMap({ 'xmtp/account': 'agent-a' }, {});
  setApproversMap({});
  onCallEvent(invite(), 'xmtp', create);
  expect(made).toEqual([]);
});
