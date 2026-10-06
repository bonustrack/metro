import WebSocket from 'ws';
import { errMsg, log } from '@metro-labs/core/log';
import { isRecord } from '@metro-labs/core/is-record';
import { pcmOf, upsample2 } from './audio.js';
import { elevenLabs, parsed, wsText } from './scribe.js';

const TTS_MODEL = 'eleven_flash_v2_5';

export interface Voiced {
  audio(pcm48k: Int16Array, chars: number): void;
  done(): void;
}

function ttsUrl(voiceId: string): string {
  const query = new URLSearchParams({
    model_id: TTS_MODEL,
    output_format: 'pcm_24000',
    auto_mode: 'true',
    inactivity_timeout: '180',
  });
  return `${elevenLabs()}/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream-input?${query.toString()}`;
}

const charsOf = (msg: Record<string, unknown>): number => {
  const alignment = msg.alignment;
  return isRecord(alignment) && Array.isArray(alignment.chars) ? alignment.chars.length : 0;
};

const MAX_REASON = 300;

export class Utterance {
  private readonly ws: WebSocket;
  private readonly outbox: string[] = [];
  private listener: Voiced | null = null;
  private carry = 0;
  private closed = false;
  private aborted = false;
  private voiced = false;
  private refusal: string | null = null;
  private finished = false;

  constructor(apiKey: string, voiceId: string, private readonly failed: (reason: string) => void) {
    this.ws = new WebSocket(ttsUrl(voiceId), { headers: { 'xi-api-key': apiKey } });
    this.ws.on('open', () => {
      if (this.aborted) return;
      this.ws.send(JSON.stringify({ text: ' ' }));
      for (const line of this.outbox.splice(0)) this.ws.send(line);
    });
    this.ws.on('message', (data) => {
      this.onMessage(wsText(data));
    });
    this.ws.on('error', (err) => {
      if (this.aborted || this.finished) return;
      this.refusal ??= errMsg(err);
      log.warn({ err: errMsg(err) }, 'voice: text to speech connection error');
    });
    this.ws.on('close', (code, why) => {
      this.closed = true;
      const reason = this.refusal ?? (code === 1000 ? null : (why.toString() || `closed (${String(code)})`));
      this.complete(reason);
    });
  }

  get usable(): boolean {
    return !this.closed && this.listener === null && this.ws.readyState <= WebSocket.OPEN;
  }

  attach(listener: Voiced): void {
    if (!this.aborted && !this.finished) this.listener = listener;
  }

  say(text: string): void {
    this.post({ text: `${text} ` });
  }

  end(): void {
    this.post({ text: '' });
  }

  abort(): void {
    if (this.aborted) return;
    this.aborted = true;
    this.listener = null;
    this.outbox.length = 0;
    this.ws.terminate();
  }

  private complete(reason: string | null): void {
    if (this.aborted || this.finished) return;
    this.finished = true;
    const listener = this.listener;
    this.listener = null;
    this.outbox.length = 0;
    const failure = reason ?? (listener !== null && !this.voiced ? 'no audio received' : null);
    if (failure !== null) this.failed(failure.slice(0, MAX_REASON));
    else listener?.done();
  }

  private post(msg: Record<string, unknown>): void {
    if (this.aborted || this.closed || this.finished) return;
    const line = JSON.stringify(msg);
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(line);
    else this.outbox.push(line);
  }

  private refused(msg: Record<string, unknown>, raw: string): void {
    if (typeof msg.message === 'string' && msg.message !== '') this.refusal ??= msg.message;
    log.warn({ msg: raw.slice(0, MAX_REASON) }, 'voice: text to speech said');
  }

  private audio(encoded: string, chars: number): void {
    this.voiced = true;
    const pcm = pcmOf(Buffer.from(encoded, 'base64'));
    const up = upsample2(pcm, this.carry);
    this.carry = pcm.at(-1) ?? this.carry;
    this.listener?.audio(up, chars);
  }

  private onMessage(raw: string): void {
    if (this.aborted || this.finished) return;
    const msg = parsed(raw);
    if (typeof msg.audio === 'string' && msg.audio !== '') this.audio(msg.audio, charsOf(msg));
    else if (msg.isFinal !== true) this.refused(msg, raw);
    if (this.refusal !== null || msg.isFinal === true) {
      this.complete(this.refusal);
      this.ws.close(1000);
    }
  }
}
