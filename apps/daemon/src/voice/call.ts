import { randomUUID } from 'node:crypto';
import { errMsg, log } from '@metro-labs/core/log';
import { isRecord } from '@metro-labs/core/is-record';
import { forwardTrainCall } from '../stations/train-call.js';
import { Peer } from './peer.js';
import { Talk } from './talk.js';
import type { VoiceConfig } from './store.js';

const OFFER_WAIT_MS = 45_000;
const LONGEST_CALL_MS = 60 * 60_000;
const CONTEXT_MESSAGES = 12;
const CONTEXT_CHARS = 400;

interface CallStart {
  line: string;
  from: string;
  callerName: string;
  callId: string;
  callerPeer: string;
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '');

async function trainCall(action: string, args: Record<string, unknown>): Promise<unknown> {
  const answer = await forwardTrainCall('xmtp', action, args);
  if (answer.error !== undefined) throw new Error(answer.error);
  return answer.result;
}

function contextLine(row: unknown, start: CallStart): string | null {
  if (!isRecord(row) || typeof row.text !== 'string' || row.text.startsWith('[call')) return null;
  const who = row.from === start.from ? start.callerName : 'you';
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

function opening(start: CallStart, chat: string): string {
  const recent = chat === '' ? '' : ` Recent chat messages before the call, oldest first (times in UTC):\n${chat}\n`;
  return `[A voice call with ${start.callerName} is starting on Stage, in your chat with them.${recent} Greet ${start.callerName} in a few words.]`;
}

export class Call {
  private readonly selfPeer = randomUUID();
  private readonly startedAt = Date.now();
  private readonly talk: Talk;
  private peer: Peer | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private longest: ReturnType<typeof setTimeout>;
  private over = false;

  constructor(
    readonly start: CallStart,
    cfg: VoiceConfig,
    private readonly onOver: () => void,
  ) {
    this.talk = new Talk(
      cfg,
      (opus, timestamp, marker) => {
        this.peer?.sendOpus(opus, timestamp, marker);
      },
      (reason) => {
        this.hangUp(reason);
      },
    );
    this.longest = setTimeout(() => {
      this.hangUp('the call reached one hour');
    }, LONGEST_CALL_MS);
  }

  async begin(): Promise<void> {
    log.info({ line: this.start.line, callId: this.start.callId }, 'voice: answering a call');
    this.talk.prime(opening(this.start, await recentChat(this.start)));
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
    else if (raw.kind === 'leave' && fromCaller) this.end('the caller hung up', false);
  }

  hangUp(reason: string): void {
    this.end(reason, true);
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

  private end(reason: string, sendLeave: boolean): void {
    if (this.over) return;
    this.over = true;
    if (this.timer !== null) clearTimeout(this.timer);
    clearTimeout(this.longest);
    log.info({ reason, seconds: Math.round((Date.now() - this.startedAt) / 1000) }, 'voice: call over');
    this.wrapUp(reason, sendLeave)
      .catch((err: unknown) => {
        log.warn({ err: errMsg(err) }, 'voice: wrapping up the call failed');
      })
      .finally(() => {
        this.onOver();
      });
  }

  private async wrapUp(reason: string, sendLeave: boolean): Promise<void> {
    if (sendLeave)
      await this.signal({ kind: 'leave', callId: this.start.callId, from: this.selfPeer }).catch((err: unknown) => {
        log.warn({ err: errMsg(err) }, 'voice: could not send the hang-up');
      });
    this.peer?.close();
    const notes = await this.talk.finish();
    const minutes = Math.max(1, Math.round((Date.now() - this.startedAt) / 60_000));
    const timing = this.talk.replyTime === null ? '' : `\n${this.talk.replyTime}`;
    const failure = reason.startsWith('the caller') || reason === 'no offer arrived' ? null : `The voice call ended: ${reason}.`;
    const text = [failure, notes === null ? null : `Call notes (${String(minutes)} min):\n${notes}${timing}`].filter((part) => part !== null).join('\n\n');
    if (text !== '') await trainCall('send', { line: this.start.line, text });
  }
}
