import WebSocket from 'ws';
import { errMsg, log } from '@metro-labs/core/log';
import { isRecord } from '@metro-labs/core/is-record';
import { pcmOf, upsample2 } from './audio.js';
import { elevenLabs, parsed, wsText } from './scribe.js';

const TTS_MODEL = 'eleven_flash_v2_5';

interface Voiced {
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

export class Utterance {
  private readonly ws: WebSocket;
  private readonly outbox: string[] = [];
  private listener: Voiced | null = null;
  private carry = 0;
  private closed = false;

  constructor(apiKey: string, voiceId: string) {
    this.ws = new WebSocket(ttsUrl(voiceId), { headers: { 'xi-api-key': apiKey } });
    this.ws.on('open', () => {
      this.ws.send(JSON.stringify({ text: ' ' }));
      for (const line of this.outbox.splice(0)) this.ws.send(line);
    });
    this.ws.on('message', (data) => {
      this.onMessage(wsText(data));
    });
    this.ws.on('error', (err) => {
      log.warn({ err: errMsg(err) }, 'voice: text to speech connection error');
    });
    this.ws.on('close', () => {
      this.closed = true;
      this.listener?.done();
      this.listener = null;
    });
  }

  get usable(): boolean {
    return !this.closed && this.listener === null && this.ws.readyState <= WebSocket.OPEN;
  }

  attach(listener: Voiced): void {
    this.listener = listener;
  }

  say(text: string): void {
    this.post({ text: `${text} ` });
  }

  end(): void {
    this.post({ text: '' });
  }

  abort(): void {
    this.listener = null;
    this.ws.terminate();
  }

  private post(msg: Record<string, unknown>): void {
    const line = JSON.stringify(msg);
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(line);
    else this.outbox.push(line);
  }

  private onMessage(raw: string): void {
    const msg = parsed(raw);
    if (typeof msg.audio === 'string' && msg.audio !== '') {
      const pcm = pcmOf(Buffer.from(msg.audio, 'base64'));
      const up = upsample2(pcm, this.carry);
      this.carry = pcm.at(-1) ?? this.carry;
      this.listener?.audio(up, charsOf(msg));
    } else if (msg.isFinal !== true) log.warn({ msg: raw.slice(0, 300) }, 'voice: text to speech said');
  }
}
