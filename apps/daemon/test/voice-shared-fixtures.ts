import type { CallRoute, SpeechStatus } from '@metro-labs/core/call';
import type { CallDependencies, CallStart } from '../src/voice/call.ts';
import type { PeerEvents } from '../src/voice/peer.ts';
import type { SharedSpeechAction } from '../src/voice/shared.ts';
import type { Voiced } from '../src/voice/speech.ts';
import type { VoiceConfig } from '../src/voice/store.ts';

export const voiceConfig: VoiceConfig = {
  provider: 'elevenlabs', apiKey: 'fake-key', voiceId: 'fake-voice', model: 'fake-model', language: 'en', enabled: true,
};

export const callStart: CallStart = {
  agentId: 'agent-a', sourceId: 'invite-a', line: 'metro://xmtp/account/chat', lineName: 'Group', direct: false,
  from: 'metro://xmtp/account/user/owner', callerName: 'Owner', callId: 'call-a', callerPeer: 'peer-a',
};

export const pause = (ms = 10): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class FakeSpeech {
  events: Voiced = { audio: () => undefined, done: () => undefined };
  words: string[] = [];
  aborted = 0;
  ended = 0;

  constructor(readonly failed: (reason: string) => void) {}

  attach(events: Voiced): void { this.events = events; }
  say(text: string): void { this.words.push(text); }
  end(): void { this.ended += 1; }
  abort(): void { this.aborted += 1; }
  audio(frames = 1): void { this.events.audio(new Int16Array(960 * frames), 5); }
  done(): void { this.events.done(); }
}

export function speechAction(id = 'action', valid = (): boolean => true): { action: SharedSpeechAction; statuses: SpeechStatus[] } {
  const statuses: SpeechStatus[] = [];
  return { action: { actionId: id, text: `Text ${id}`, isValid: valid, status: (status) => { statuses.push(status); } }, statuses };
}

export class FakeCall {
  events: string[] = [];
  calls: { action: string; args: Record<string, unknown> }[] = [];
  routes: CallRoute[] = [];
  inputs: { route: CallRoute; text: string; sourceId: string }[] = [];
  peer: PeerEvents = { audio: () => undefined, state: () => undefined };
  heard: (text: string, sourceId: string) => void = () => undefined;
  signal: (args: Record<string, unknown>) => Promise<unknown> = () => Promise.resolve();
  answer: () => Promise<string> = () => Promise.resolve('fake-answer');
  send: () => Promise<void> = () => Promise.resolve();
  available = true;
  selected = true;

  audio = {
    connect: (): void => { this.events.push('connect'); },
    hear: (): void => { this.events.push('hear'); },
    finish: (): void => { this.events.push('finish'); },
    prime: (): void => { this.events.push('prime'); },
    enqueue: (): boolean => true,
    terminate: (): void => { this.events.push('terminate'); },
  };

  deps: Partial<CallDependencies> = {
    train: async (action, args) => {
      this.calls.push({ action, args });
      return action === 'callSignal' ? await this.signal(args) : { messages: [] };
    },
    peer: (events) => {
      this.peer = events;
      return {
        answer: () => this.answer(),
        sendOpus: () => this.send(),
        close: () => { this.events.push('peer-close'); },
      };
    },
    cli: () => { this.events.push('cli'); return this.audio; },
    shared: (_cfg, _out, _ended, heard) => {
      this.heard = heard;
      this.events.push('shared');
      return this.audio;
    },
    selected: () => this.selected,
    open: (route) => { this.routes.push(route); return this.available; },
    heard: (route, text, sourceId) => { this.inputs.push({ route, text, sourceId }); },
    ended: () => { this.events.push('ended'); },
    signalWaitMs: 15,
    leaveRetryMs: 1,
  };
}
