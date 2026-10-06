import { expect, test } from 'bun:test';
import type { CallNotice } from '@metro-labs/core/call';
import { isRecord } from '@metro-labs/core/is-record';
import { Call } from '../src/voice/call.ts';
import type { Heard } from '../src/voice/scribe.ts';
import { SharedTalk } from '../src/voice/shared-talk.ts';
import { SharedCalls } from '../src/voice/shared.ts';
import { SpeechQueue } from '../src/voice/speech-queue.ts';
import { callStart, FakeCall, FakeSpeech, pause, speechAction, voiceConfig } from './voice-shared-fixtures.ts';

function fixture(manager = new SharedCalls(() => true, () => 'allow')) {
  const network = new FakeCall();
  const notices: CallNotice[] = [];
  const speech: FakeSpeech[] = [];
  const talks: SharedTalk[] = [];
  const inputs: Heard[] = [];
  const state = { reject: '', current: false, scribeClosed: 0, throwSpeech: false };
  manager.connect({
    available: () => true,
    notify: (notice) => { notices.push(notice); return notice.type !== state.reject; },
    revoked: () => { network.events.push('revoked'); },
  });
  const call = new Call(callStart, voiceConfig, () => {
    state.current = false;
    network.events.push('over');
  }, {
    ...network.deps,
    shared: (cfg, send, ended, heard) => {
      const queue = new SpeechQueue(cfg, send, (failed) => {
        if (state.throwSpeech) throw new Error('fake private provider detail');
        const utterance = new FakeSpeech(failed);
        speech.push(utterance);
        return utterance;
      });
      const talk = new SharedTalk(cfg, send, ended, heard, (events) => {
        inputs.push(events);
        return { send: () => undefined, close: () => { state.scribeClosed += 1; } };
      }, queue);
      talks.push(talk);
      return talk;
    },
    open: (route, sourceId, transport) => manager.open(route, sourceId, transport),
    heard: (route, text, sourceId) => manager.heard(route, text, sourceId),
    ended: (route) => manager.end(route),
  });
  state.current = true;
  return { call, manager, network, notices, speech, talks, inputs, state };
}

async function connect(f: ReturnType<typeof fixture>): Promise<void> {
  await f.call.begin();
  const join = f.network.calls[0]?.args.signal;
  if (!isRecord(join)) throw new Error('call did not join');
  f.call.signalled({ kind: 'offer', from: callStart.callerPeer, to: join.from, callId: callStart.callId, sdp: 'fake-offer' });
  await pause();
  f.network.peer.state('connected');
}

for (const failure of ['disconnect', 'heard'] as const) {
  test(`shared ${failure} closes the physical call before a stuck leave and ignores late callbacks`, async () => {
    const f = fixture();
    try {
      await connect(f);
      const target = { callId: f.call.route.callId, generation: f.call.route.generation, sourceId: callStart.sourceId };
      f.manager.speak(callStart.line, target, 'Current speech', new Set([callStart.agentId]));
      await pause();
      f.speech[0]?.audio(100);
      const queued = speechAction('queued');
      expect(f.talks[0]?.enqueue(queued.action)).toBe(true);
      f.network.signal = () => {
        f.network.events.push('leave');
        return new Promise(() => undefined);
      };
      if (failure === 'disconnect') f.manager.disconnect();
      else {
        f.state.reject = 'heard';
        f.inputs[0]?.committed('These words cannot reach the conversation');
      }
      expect(f.state.current).toBe(false);
      expect(f.state.scribeClosed).toBe(1);
      expect(f.network.events).toEqual(['revoked', 'peer-close', 'over', 'leave']);
      expect(f.speech[0]?.aborted).toBe(1);
      expect(queued.statuses).toEqual(['interrupted']);
      expect(f.notices.filter((notice) => notice.type === 'speech').at(-1)).toMatchObject({ status: 'interrupted' });
      expect(f.notices.filter((notice) => notice.type === 'ended')).toHaveLength(1);
      expect(f.manager.valid({ route: f.call.route, sourceId: callStart.sourceId })).toBe(false);
      const before = f.notices.length;
      f.talks[0]?.terminate();
      f.manager.end(f.call.route);
      f.network.peer.state('connected');
      f.network.peer.audio(Buffer.alloc(1));
      f.inputs[0]?.committed('late words');
      f.inputs[0]?.failed('late failure');
      f.speech[0]?.audio();
      f.speech[0]?.done();
      expect(f.notices).toHaveLength(before);
      expect(f.state.scribeClosed).toBe(1);
      expect(f.network.events).toEqual(['revoked', 'peer-close', 'over', 'leave']);
      expect(f.talks[0]?.enqueue(speechAction('late').action)).toBe(false);
      expect(f.network.calls.some((call) => call.action === 'read' || call.action === 'send')).toBe(false);
      await f.call.leave('duplicate');
      expect(f.network.calls.filter((call) => isRecord(call.args.signal) && call.args.signal.kind === 'leave')).toHaveLength(2);
    } finally {
      await f.call.leave('test cleanup');
    }
  });
}

for (const failure of ['provider', 'exception', 'transport', 'empty'] as const) {
  test(`${failure} speech failure is reported before physical hangup without exposing provider details`, async () => {
    const f = fixture();
    try {
      await connect(f);
      f.state.throwSpeech = failure === 'exception';
      const target = { callId: f.call.route.callId, generation: f.call.route.generation, sourceId: callStart.sourceId };
      f.manager.speak(callStart.line, target, 'Current speech', new Set([callStart.agentId]));
      await pause();
      if (failure === 'provider') f.speech[0]?.failed('fake private provider detail');
      else if (failure === 'transport') {
        f.speech[0]?.audio();
        f.network.send = () => Promise.reject(new Error('fake private provider detail'));
        await pause(40);
      } else if (failure === 'empty') f.speech[0]?.done();
      expect(f.state.current).toBe(false);
      expect(f.state.scribeClosed).toBe(1);
      const statuses = f.notices.filter((notice) => notice.type === 'speech');
      expect(statuses.map((notice) => notice.status)).toEqual(['accepted', 'queued', 'failed']);
      expect(f.notices.slice(-2).map((notice) => notice.type)).toEqual(['speech', 'ended']);
      expect(JSON.stringify(f.notices)).not.toContain('fake private provider detail');
      expect(f.network.events).toEqual(['peer-close', 'revoked', 'over']);
      const before = f.notices.length;
      f.speech[0]?.failed('late failure');
      f.inputs[0]?.committed('late words');
      f.talks[0]?.terminate();
      expect(f.notices).toHaveLength(before);
      expect(f.state.scribeClosed).toBe(1);
      expect(f.network.calls.some((call) => call.action === 'read' || call.action === 'send')).toBe(false);
    } finally {
      await f.call.leave('test cleanup');
    }
  });
}

test('audio cancellation leaves the physical call and committed STT connected', async () => {
  const f = fixture();
  try {
    await connect(f);
    const target = { callId: f.call.route.callId, generation: f.call.route.generation, sourceId: callStart.sourceId };
    f.manager.speak(callStart.line, target, 'Current speech', new Set([callStart.agentId]));
    await pause();
    f.speech[0]?.audio(100);
    f.talks[0]?.cancel();
    f.inputs[0]?.committed('Continue this conversation');
    expect(f.state.current).toBe(true);
    expect(f.state.scribeClosed).toBe(0);
    expect(f.network.events).toEqual([]);
    expect(f.notices.some((notice) => notice.type === 'ended')).toBe(false);
    expect(f.notices.filter((notice) => notice.type === 'speech').at(-1)).toMatchObject({ status: 'interrupted' });
    expect(f.notices.at(-1)).toMatchObject({ type: 'heard', text: 'Continue this conversation' });
    expect(f.talks[0]?.enqueue(speechAction('next').action)).toBe(true);
  } finally {
    await f.call.leave('test cleanup');
  }
});

test('a terminated transport cannot close a replacement call on the same manager', async () => {
  const old = fixture();
  await old.call.begin();
  const next = fixture(old.manager);
  try {
    await next.call.begin();
    expect(old.state.current).toBe(false);
    expect(next.call.route.generation).not.toBe(old.call.route.generation);
    old.talks[0]?.terminate();
    old.manager.end(old.call.route);
    old.inputs[0]?.committed('stale words');
    expect(next.state.current).toBe(true);
    expect(next.state.scribeClosed).toBe(0);
    expect(next.manager.valid({ route: next.call.route, sourceId: callStart.sourceId })).toBe(true);
    expect(next.notices.map((notice) => notice.type)).toEqual(['started']);
  } finally {
    await old.call.leave('test cleanup');
    await next.call.leave('test cleanup');
  }
});

test('a rejected start notice terminates local STT and frees the call slot without joining', async () => {
  const f = fixture();
  f.state.reject = 'started';
  try {
    await expect(f.call.begin()).rejects.toThrow('shared conversation is unavailable');
    expect(f.state.current).toBe(false);
    expect(f.state.scribeClosed).toBe(1);
    expect(f.network.events).toEqual(['revoked', 'over']);
    expect(f.network.calls.some((call) => isRecord(call.args.signal) && call.args.signal.kind === 'join')).toBe(false);
    expect(f.talks[0]?.enqueue(speechAction('late').action)).toBe(false);
  } finally {
    await f.call.leave('test cleanup');
  }
});
