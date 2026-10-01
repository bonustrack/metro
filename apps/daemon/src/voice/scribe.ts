import WebSocket from 'ws';
import { errMsg, log } from '@metro-labs/core/log';
import { isRecord } from '@metro-labs/core/is-record';
import { bytesOf } from './audio.js';

export const elevenLabs = (): string => process.env.METRO_ELEVENLABS_URL ?? 'wss://api.elevenlabs.io';
const STT_RATE = 16_000;
const CHUNK_SAMPLES = STT_RATE / 10;
const HELD_SAMPLES = STT_RATE * 2;
export const VAD_SILENCE_SECS = 0.5;

interface Heard {
  partial(text: string): void;
  committed(text: string): void;
  failed(reason: string): void;
}

const FATAL = new Set([
  'auth_error',
  'quota_exceeded',
  'unaccepted_terms',
  'rate_limited',
  'resource_exhausted',
  'session_time_limit_exceeded',
  'error',
]);

export function wsText(data: WebSocket.RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return (Buffer.isBuffer(data) ? data : Buffer.from(data)).toString('utf8');
}

export function parsed(raw: string): Record<string, unknown> {
  try {
    const msg: unknown = JSON.parse(raw);
    return isRecord(msg) ? msg : {};
  } catch {
    return {};
  }
}

function sttUrl(): string {
  const query = new URLSearchParams({
    model_id: 'scribe_v2_realtime',
    audio_format: 'pcm_16000',
    commit_strategy: 'vad',
    vad_silence_threshold_secs: String(VAD_SILENCE_SECS),
  });
  return `${elevenLabs()}/v1/speech-to-text/realtime?${query.toString()}`;
}

export class Scribe {
  private readonly ws: WebSocket;
  private buffer: Int16Array[] = [];
  private buffered = 0;

  constructor(apiKey: string, private readonly heard: Heard) {
    this.ws = new WebSocket(sttUrl(), { headers: { 'xi-api-key': apiKey } });
    this.ws.on('message', (data) => {
      this.onMessage(wsText(data));
    });
    this.ws.on('error', (err) => {
      log.warn({ err: errMsg(err) }, 'voice: speech to text connection error');
    });
    this.ws.on('close', (code) => {
      if (code !== 1000) this.heard.failed(`speech to text closed (${String(code)})`);
    });
  }

  send(pcm16k: Int16Array): void {
    this.buffer.push(pcm16k);
    this.buffered += pcm16k.length;
    while (this.buffered > HELD_SAMPLES) this.buffered -= this.buffer.shift()?.length ?? this.buffered;
    if (this.buffered < CHUNK_SAMPLES || this.ws.readyState !== WebSocket.OPEN) return;
    const chunk = new Int16Array(this.buffered);
    let at = 0;
    for (const part of this.buffer) {
      chunk.set(part, at);
      at += part.length;
    }
    this.buffer = [];
    this.buffered = 0;
    this.ws.send(
      JSON.stringify({ message_type: 'input_audio_chunk', audio_base_64: bytesOf(chunk).toString('base64'), commit: false, sample_rate: STT_RATE }),
    );
  }

  close(): void {
    this.ws.close(1000);
  }

  private onMessage(raw: string): void {
    const msg = parsed(raw);
    const type = typeof msg.message_type === 'string' ? msg.message_type : '';
    const text = typeof msg.text === 'string' ? msg.text.trim() : '';
    if (type === 'partial_transcript') this.heard.partial(text);
    else if (type === 'committed_transcript') {
      if (text !== '') this.heard.committed(text);
    } else if (FATAL.has(type)) this.heard.failed(`speech to text: ${typeof msg.error === 'string' ? msg.error : type}`);
    else log.debug({ type }, 'voice: speech to text said');
  }
}
