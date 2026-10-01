import { randomUUID } from 'node:crypto';
import { errMsg, log } from '@metro-labs/core/log';
import { isRecord } from '@metro-labs/core/is-record';
import { forwardTrainCall } from '../stations/train-call.js';
import { CallApprovals } from './approvals.js';
import { Peer } from './peer.js';
import { Talk } from './talk.js';
import type { VoiceConfig } from './store.js';

const OFFER_WAIT_MS = 45_000;
const LONGEST_CALL_MS = 60 * 60_000;
const CONTEXT_MESSAGES = 12;
const CONTEXT_CHARS = 400;
const LEAVE_RETRY_MS = 3_000;

interface CallStart {
  line: string;
  lineName: string;
  direct: boolean;
  from: string;
  callerName: string;
  callId: string;
  callerPeer: string;
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '');

export async function trainCall(action: string, args: Record<string, unknown>): Promise<unknown> {
  const answer = await forwardTrainCall('xmtp', action, args);
  if (answer.error !== undefined) throw new Error(answer.error);
  return answer.result;
}

function speaker(row: Record<string, unknown>, start: CallStart): string {
  if (row.self === true) return 'you';
  return row.from === start.from ? start.callerName : `another member (${str(row.from)})`;
}

function contextLine(row: unknown, start: CallStart): string | null {
  if (!isRecord(row) || typeof row.text !== 'string' || row.text.startsWith('[call')) return null;
  const who = speaker(row, start);
  return `${str(row.ts).slice(11, 16)} ${who}: ${row.text.replace(/\s+/g, ' ').slice(0, CONTEXT_CHARS)}`;
}

async function recentChat(start: CallStart): Promise<string> {
  try {
    const result = await trainCall('read', { line: start.line, limit: CONTEXT_MESSAGES });
    const rows = isRecord(result) && Array.isArray(result.messages) ? result.messages : [];
    return rows.map((row) => contextLine(row, start)).filter((l): l is string => l !== null).join('\n');
  } catch (err) {
    log.warn({ err: errMsg(err) }, 'voice: could not read the chat before the call');
    return '';
  }
}

function where(start: CallStart): string {
  if (start.lineName !== '') return `the group chat "${start.lineName}"`;
  return start.direct ? `your direct chat with ${start.callerName}` : 'a group chat with no name';
}

export function opening(start: CallStart, chat: string): string {
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
  private readonly selfPeer = randomUUID();
  private readonly startedAt = Date.now();
  private readonly talk: Talk;
  private peer: Peer | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private longest: ReturnType<typeof setTimeout>;
  private over = false;
  private left: Promise<void> = Promise.resolve();

  constructor(
    readonly start: CallStart,
    cfg: VoiceConfig,
    private readonly onOver: () => void,
  ) {
    const approvals = new CallApprovals(start.line, async (text) => {
      await trainCall('send', { line: start.line, text });
    });
    this.talk = new Talk(
      cfg,
      (opus, timestamp, marker) => {
        this.peer?.sendOpus(opus, timestamp, marker);
      },
      (reason) => {
        this.hangUp(reason);
      },
      approvals,
    );
    this.longest = setTimeout(() => {
      this.hangUp('the call reached one hour');
    }, LONGEST_CALL_MS);
  }

  async begin(): Promise<void> {
    log.info({ line: this.start.line, callId: this.start.callId }, 'voice: answering a call');
    recentChat(this.start)
      .then((chat) => {
        if (!this.over) this.talk.prime(opening(this.start, chat));
      })
      .catch((err: unknown) => {
        log.warn({ err: errMsg(err) }, 'voice: could not start the agent on the call');
      });
    await this.signal({ kind: 'join', callId: this.start.callId, from: this.selfPeer });
    this.timer = setTimeout(() => {
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
    this.peer = new Peer({
      audio: (opus) => {
        this.talk.hear(opus);
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
    log.info({ state, afterMs: Date.now() - this.startedAt }, 'voice: call connection');
    if (state === 'connected') this.talk.connect();
    else if (state === 'failed' || state === 'closed') this.hangUp(`the connection ${state}`);
  }

  private signal(signal: Record<string, unknown>): Promise<unknown> {
    return trainCall('callSignal', { line: this.start.line, signal });
  }

  private end(reason: string): void {
    if (this.over) return;
    this.over = true;
    if (this.timer !== null) clearTimeout(this.timer);
    clearTimeout(this.longest);
    log.info({ reason, seconds: Math.round((Date.now() - this.startedAt) / 1000) }, 'voice: call over');
    this.left = this.sendLeave();
    this.left
      .then(() => this.wrapUp(reason))
      .catch((err: unknown) => {
        log.warn({ err: errMsg(err) }, 'voice: wrapping up the call failed');
      })
      .finally(() => {
        this.onOver();
      });
  }

  private async sendLeave(): Promise<void> {
    const leave = { kind: 'leave', callId: this.start.callId, from: this.selfPeer };
    try {
      await this.signal(leave);
    } catch (err) {
      log.warn({ err: errMsg(err) }, 'voice: could not send the hang-up, trying once more');
      await new Promise((r) => setTimeout(r, LEAVE_RETRY_MS));
      await this.signal(leave).catch((again: unknown) => {
        log.warn({ err: errMsg(again) }, 'voice: could not send the hang-up; the next start sends it');
      });
    }
  }

  private async wrapUp(reason: string): Promise<void> {
    this.peer?.close();
    this.talk.finish();
    if (reason.startsWith('the caller') || reason === 'no offer arrived') return;
    await trainCall('send', { line: this.start.line, text: `The voice call ended: ${reason}.` });
  }
}
