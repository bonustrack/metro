import { randomUUID } from 'node:crypto';
import type { CallRoute } from '@metro-labs/core/call';
import { errMsg, log } from '@metro-labs/core/log';
import { isRecord } from '@metro-labs/core/is-record';
import { forwardTrainCall } from '../stations/train-call.js';
import { CallApprovals } from './approvals.js';
import type { Playback } from './audio.js';
import { Peer, type PeerEvents } from './peer.js';
import { SharedTalk } from './shared-talk.js';
import { endSharedCall, hearSharedCall, openSharedCall, sharedCallsSelected, type SharedCallTransport } from './shared.js';
import { Talk } from './talk.js';
import type { VoiceConfig } from './store.js';

const OFFER_WAIT_MS = 45_000;
const LONGEST_CALL_MS = 60 * 60_000;
const CONTEXT_MESSAGES = 12;
const CONTEXT_CHARS = 400;
const LEAVE_RETRY_MS = 3_000;
const SIGNAL_WAIT_MS = 2_000;

export interface CallStart {
  agentId: string;
  sourceId: string;
  line: string;
  lineName: string;
  direct: boolean;
  from: string;
  callerName: string;
  callId: string;
  callerPeer: string;
}

type CallAudio = Pick<Talk, 'connect' | 'hear' | 'finish'>;
type CallPeer = Pick<Peer, 'answer' | 'sendOpus' | 'close'>;
type ContextStart = Omit<CallStart, 'agentId' | 'sourceId'>;

export interface CallDependencies {
  train: typeof trainCall;
  peer(events: PeerEvents): CallPeer;
  cli(cfg: VoiceConfig, out: Playback['send'], ended: (reason: string) => void, approvals: CallApprovals): CallAudio & Pick<Talk, 'prime'>;
  shared(cfg: VoiceConfig, out: Playback['send'], ended: (reason: string) => void, heard: (text: string, sourceId: string) => void): CallAudio & SharedCallTransport;
  selected: typeof sharedCallsSelected;
  open: typeof openSharedCall;
  heard: typeof hearSharedCall;
  ended: typeof endSharedCall;
  signalWaitMs: number;
  leaveRetryMs: number;
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '');

export async function trainCall(action: string, args: Record<string, unknown>): Promise<unknown> {
  const answer = await forwardTrainCall('xmtp', action, args);
  if (answer.error !== undefined) throw new Error(answer.error);
  return answer.result;
}

const dependencies: CallDependencies = {
  train: trainCall,
  peer: (events) => new Peer(events),
  cli: (cfg, out, ended, approvals) => new Talk(cfg, out, ended, approvals),
  shared: (cfg, out, ended, heard) => new SharedTalk(cfg, out, ended, heard),
  selected: sharedCallsSelected,
  open: openSharedCall,
  heard: hearSharedCall,
  ended: endSharedCall,
  signalWaitMs: SIGNAL_WAIT_MS,
  leaveRetryMs: LEAVE_RETRY_MS,
};

function speaker(row: Record<string, unknown>, start: ContextStart): string {
  if (row.self === true) return 'you';
  return row.from === start.from ? start.callerName : `another member (${str(row.from)})`;
}

function contextLine(row: unknown, start: ContextStart): string | null {
  if (!isRecord(row) || typeof row.text !== 'string' || row.text.startsWith('[call')) return null;
  const who = speaker(row, start);
  return `${str(row.ts).slice(11, 16)} ${who}: ${row.text.replace(/\s+/g, ' ').slice(0, CONTEXT_CHARS)}`;
}

async function recentChat(start: CallStart, train: typeof trainCall): Promise<string> {
  try {
    const result = await train('read', { line: start.line, limit: CONTEXT_MESSAGES });
    const rows = isRecord(result) && Array.isArray(result.messages) ? result.messages : [];
    return rows.map((row) => contextLine(row, start)).filter((l): l is string => l !== null).join('\n');
  } catch (err) {
    log.warn({ err: errMsg(err) }, 'voice: could not read the chat before the call');
    return '';
  }
}

function where(start: ContextStart): string {
  if (start.lineName !== '') return `the group chat "${start.lineName}"`;
  return start.direct ? `your direct chat with ${start.callerName}` : 'a group chat with no name';
}

export function opening(start: ContextStart, chat: string): string {
  const recent = chat === '' ? 'No earlier messages were found there.' : `Recent messages there before the call, oldest first (times in UTC):\n${chat}`;
  return [
    `[A voice call with ${start.callerName} is starting on Stage, in ${where(start)}.`,
    `Line of this chat: ${start.line} (pass it verbatim to the metro tools, e.g. read, to look at or act on this chat).`,
    `Caller: ${start.callerName} (${start.from}).`,
    recent,
    `Greet ${start.callerName} in a few words.]`,
  ].join('\n');
}

export class Call {
  readonly route: CallRoute;
  private readonly selfPeer = randomUUID();
  private readonly startedAt = Date.now();
  private readonly talk: CallAudio;
  private readonly shared: SharedCallTransport | null;
  private readonly prime: ((context: string) => void) | null;
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
    if (this.deps.selected()) {
      const shared = this.deps.shared(cfg, out, ended, (text, sourceId) => {
        if (!this.over) this.deps.heard(this.route, text, sourceId);
      });
      this.talk = shared;
      this.shared = shared;
      this.prime = null;
    } else {
      const approvals = new CallApprovals(start.line, async (text) => {
        await this.deps.train('send', { line: start.line, text });
      });
      const cli = this.deps.cli(cfg, out, ended, approvals);
      this.talk = cli;
      this.shared = null;
      this.prime = (context) => {
        cli.prime(context);
      };
    }
    this.longest = setTimeout(() => {
      this.hangUp('the call reached one hour');
    }, LONGEST_CALL_MS);
  }

  async begin(): Promise<void> {
    if (this.over || this.begun) return;
    this.begun = true;
    log.info({ line: this.start.line, callId: this.start.callId }, 'voice: answering a call');
    if (this.shared !== null) {
      if (!this.deps.open(this.route, this.start.sourceId, this.shared)) throw new Error('the shared conversation is unavailable');
    } else {
      recentChat(this.start, this.deps.train).then((chat) => {
        if (!this.over) this.prime?.(opening(this.start, chat));
      }).catch((err: unknown) => {
        log.warn({ err: errMsg(err) }, 'voice: could not start the agent on the call');
      });
    }
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

  hangUp(reason: string): void {
    this.end(reason);
  }

  leave(reason: string): Promise<void> {
    this.end(reason);
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

  private end(reason: string): void {
    if (this.over) return;
    this.over = true;
    if (this.timer !== null) clearTimeout(this.timer);
    clearTimeout(this.longest);
    log.info({ reason, seconds: Math.round((Date.now() - this.startedAt) / 1000) }, 'voice: call over');
    this.talk.finish();
    this.peer?.close();
    if (this.shared !== null) this.deps.ended(this.route);
    this.onOver();
    this.left = this.sendLeave().then(async () => {
      if (this.shared !== null || reason.startsWith('the caller') || reason === 'no offer arrived') return;
      await this.deps.train('send', { line: this.start.line, text: `The voice call ended: ${reason}.` });
    }).catch((err: unknown) => {
      log.warn({ err: errMsg(err) }, 'voice: wrapping up the call failed');
    });
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
