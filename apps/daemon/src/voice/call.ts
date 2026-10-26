import { randomUUID } from 'node:crypto';
import type { CallRoute } from '@metro-labs/core/call';
import { errMsg, log } from '@metro-labs/core/log';
import { forwardTrainCall } from '../stations/train-call.js';
import type { Playback } from './audio.js';
import { Peer, type PeerEvents } from './peer.js';
import { SharedTalk } from './shared-talk.js';
import { endSharedCall, hearSharedCall, openSharedCall, type SharedCallTransport } from './shared.js';
import type { VoiceConfig } from './store.js';

const OFFER_WAIT_MS = 45_000;
const LONGEST_CALL_MS = 60 * 60_000;
const LEAVE_RETRY_MS = 3_000;
const SIGNAL_WAIT_MS = 2_000;

export interface CallStart {
  agentId: string;
  sourceId: string;
  line: string;
  from: string;
  callId: string;
  callerPeer: string;
}

type CallAudio = Pick<SharedTalk, 'connect' | 'hear' | 'finish'> & SharedCallTransport;
type CallPeer = Pick<Peer, 'answer' | 'sendOpus' | 'close'>;

export interface CallDependencies {
  train: typeof trainCall;
  peer(events: PeerEvents): CallPeer;
  shared(cfg: VoiceConfig, out: Playback['send'], ended: (reason: string) => void, heard: (text: string, sourceId: string) => void): CallAudio;
  open: typeof openSharedCall;
  heard: typeof hearSharedCall;
  ended: typeof endSharedCall;
  signalWaitMs: number;
  leaveRetryMs: number;
}

export async function trainCall(action: string, args: Record<string, unknown>): Promise<unknown> {
  const answer = await forwardTrainCall('xmtp', action, args);
  if (answer.error !== undefined) throw new Error(answer.error);
  return answer.result;
}

const dependencies: CallDependencies = {
  train: trainCall,
  peer: (events) => new Peer(events),
  shared: (cfg, out, ended, heard) => new SharedTalk(cfg, out, ended, heard),
  open: openSharedCall,
  heard: hearSharedCall,
  ended: endSharedCall,
  signalWaitMs: SIGNAL_WAIT_MS,
  leaveRetryMs: LEAVE_RETRY_MS,
};

export class Call {
  readonly route: CallRoute;
  private readonly selfPeer = randomUUID();
  private readonly startedAt = Date.now();
  private readonly talk: CallAudio;
  private readonly deps: CallDependencies;
  private peer: CallPeer | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly longest: ReturnType<typeof setTimeout>;
  private over = false;
  private begun = false;
  private left: Promise<void> = Promise.resolve();

  constructor(
    readonly start: CallStart,
    cfg: VoiceConfig,
    private readonly onOver: () => void,
    deps: Partial<CallDependencies> = {},
  ) {
    this.deps = { ...dependencies, ...deps };
    this.route = Object.freeze({ agentId: start.agentId, line: start.line, from: start.from, callId: start.callId, generation: randomUUID() });
    const out: Playback['send'] = (opus, timestamp, marker) => {
      if (this.over || this.peer === null) return Promise.reject(new Error('call audio is not connected'));
      return this.peer.sendOpus(opus, timestamp, marker);
    };
    const ended = (reason: string): void => {
      this.hangUp(reason);
    };
    this.talk = this.deps.shared(cfg, out, ended, (text, sourceId) => {
      if (!this.over) this.deps.heard(this.route, text, sourceId);
    });
    this.longest = setTimeout(() => {
      this.hangUp('the call reached one hour');
    }, LONGEST_CALL_MS);
  }

  async begin(): Promise<void> {
    if (this.over || this.begun) return;
    this.begun = true;
    log.info({ line: this.start.line, callId: this.start.callId }, 'voice: answering a call');
    if (!this.deps.open(this.route, this.start.sourceId, this.talk)) throw new Error('the shared conversation is unavailable');
    await this.signal({ kind: 'join', callId: this.start.callId, from: this.selfPeer });
    if (this.over) {
      await this.sendLeave();
      return;
    }
    if (this.peer === null) this.timer = setTimeout(() => {
      this.hangUp('no offer arrived');
    }, OFFER_WAIT_MS);
  }

  signalled(raw: Record<string, unknown>): void {
    if (raw.callId !== this.start.callId || this.over) return;
    const fromCaller = raw.from === this.start.callerPeer;
    if (raw.kind === 'offer' && fromCaller && raw.to === this.selfPeer && this.peer === null && typeof raw.sdp === 'string')
      this.answer(this.start.callerPeer, raw.sdp).catch((err: unknown) => {
        this.hangUp(`answering failed: ${errMsg(err)}`);
      });
    else if (raw.kind === 'leave' && fromCaller) this.hangUp('the caller hung up');
  }

  leave(reason: string): Promise<void> {
    this.hangUp(reason);
    return this.left;
  }

  private async answer(to: string, offer: string): Promise<void> {
    if (this.timer !== null) clearTimeout(this.timer);
    this.peer = this.deps.peer({
      audio: (opus) => {
        if (!this.over) this.talk.hear(opus);
      },
      state: (state) => {
        this.stateChanged(state);
      },
    });
    const sdp = await this.peer.answer(offer);
    if (this.over) return;
    await this.signal({ kind: 'answer', callId: this.start.callId, from: this.selfPeer, to, sdp });
  }

  private stateChanged(state: string): void {
    if (this.over) return;
    log.info({ state, afterMs: Date.now() - this.startedAt }, 'voice: call connection');
    if (state === 'connected') this.talk.connect();
    else if (state === 'failed' || state === 'closed') this.hangUp(`the connection ${state}`);
  }

  private signal(signal: Record<string, unknown>): Promise<unknown> {
    return this.deps.train('callSignal', { line: this.start.line, signal });
  }

  hangUp(reason: string): void {
    if (this.over) return;
    this.over = true;
    if (this.timer !== null) clearTimeout(this.timer);
    clearTimeout(this.longest);
    log.info({ reason, seconds: Math.round((Date.now() - this.startedAt) / 1000) }, 'voice: call over');
    this.talk.finish();
    this.peer?.close();
    this.deps.ended(this.route);
    this.onOver();
    this.left = this.sendLeave();
  }

  private async sendLeave(): Promise<void> {
    try {
      await this.leaveOnce();
    } catch (err) {
      log.warn({ err: errMsg(err) }, 'voice: could not send the hang-up, trying once more');
      await new Promise((r) => setTimeout(r, this.deps.leaveRetryMs));
      await this.leaveOnce().catch((again: unknown) => {
        log.warn({ err: errMsg(again) }, 'voice: could not send the hang-up; the next start sends it');
      });
    }
  }

  private async leaveOnce(): Promise<void> {
    const leave = { kind: 'leave', callId: this.start.callId, from: this.selfPeer };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const capped = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new Error('hang-up signal timed out'));
      }, this.deps.signalWaitMs);
    });
    try {
      await Promise.race([this.signal(leave), capped]);
    } finally {
      clearTimeout(timer);
    }
  }
}
