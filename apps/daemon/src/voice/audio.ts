import OpusScript from 'opusscript';
import { errMsg, log } from '@metro-labs/core/log';

const RATE = 48_000;
const FRAME = 960;
const FRAME_MS = 20;
const MAX_LATE_FRAMES = 5;
const MAX_QUEUED_FRAMES = 3_000;

interface Frame {
  pcm: Int16Array;
  chars: number;
}

export function downsample3(pcm: Int16Array): Int16Array {
  const out = new Int16Array(Math.floor(pcm.length / 3));
  for (let i = 0; i < out.length; i += 1)
    out[i] = Math.round(((pcm[i * 3] ?? 0) + (pcm[i * 3 + 1] ?? 0) + (pcm[i * 3 + 2] ?? 0)) / 3);
  return out;
}

export function upsample2(pcm: Int16Array, carry: number): Int16Array {
  const out = new Int16Array(pcm.length * 2);
  let prev = carry;
  for (let i = 0; i < pcm.length; i += 1) {
    const cur = pcm[i] ?? 0;
    out[i * 2] = Math.round((prev + cur) / 2);
    out[i * 2 + 1] = cur;
    prev = cur;
  }
  return out;
}

export const pcmOf = (bytes: Buffer): Int16Array => {
  const copy = Buffer.from(bytes);
  return new Int16Array(copy.buffer, copy.byteOffset, Math.floor(copy.length / 2));
};

export const bytesOf = (pcm: Int16Array): Buffer => Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);

export class OpusIn {
  private readonly decoder = new OpusScript(RATE, 1, OpusScript.Application.VOIP);

  decode(packet: Buffer): Int16Array | null {
    try {
      return pcmOf(this.decoder.decode(packet));
    } catch (err) {
      log.debug({ err: errMsg(err) }, 'voice: an audio packet could not be decoded');
      return null;
    }
  }

  close(): void {
    this.decoder.delete();
  }
}

export interface Playback {
  send(opus: Buffer, timestamp: number, marker: boolean): void | Promise<void>;
  played(chars: number): void;
}

export class Player {
  private readonly encoder = new OpusScript(RATE, 1, OpusScript.Application.VOIP);
  private readonly queue: Frame[] = [];
  private pending = new Int16Array(0);
  private pendingChars = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private started = 0;
  private sent = 0;
  private speaking = false;
  private onIdle: (() => void) | null = null;
  private onFirst: (() => void) | null = null;
  private onFailed: ((reason: string) => void) | null = null;
  private generation = 0;
  private inFlight = 0;
  private closed = false;

  constructor(private readonly out: Playback) {}

  get busy(): boolean {
    return this.queue.length > 0 || this.pending.length > 0 || this.inFlight > 0;
  }

  whenFirstPlayed(fn: () => void): void {
    this.onFirst = fn;
  }

  whenIdle(fn: () => void): void {
    this.onIdle = fn;
  }

  whenFailed(fn: (reason: string) => void): void {
    this.onFailed = fn;
  }

  push(pcm: Int16Array, chars: number): void {
    if (this.closed) return;
    if (this.queue.length + this.inFlight + Math.ceil((this.pending.length + pcm.length) / FRAME) > MAX_QUEUED_FRAMES) {
      this.failed('audio queue is full');
      return;
    }
    const joined = new Int16Array(this.pending.length + pcm.length);
    joined.set(this.pending);
    joined.set(pcm, this.pending.length);
    let at = 0;
    for (; at + FRAME <= joined.length; at += FRAME) this.queue.push({ pcm: joined.slice(at, at + FRAME), chars: 0 });
    this.pending = joined.slice(at);
    this.pendingChars += chars;
    const last = this.queue.at(-1);
    if (last !== undefined && this.pending.length === 0) {
      last.chars += this.pendingChars;
      this.pendingChars = 0;
    }
  }

  finish(): void {
    if (this.closed || this.pending.length === 0) return;
    const pcm = new Int16Array(FRAME);
    pcm.set(this.pending);
    this.queue.push({ pcm, chars: this.pendingChars });
    this.pending = new Int16Array(0);
    this.pendingChars = 0;
  }

  clear(): void {
    this.generation += 1;
    this.inFlight = 0;
    this.speaking = false;
    this.queue.length = 0;
    this.pending = new Int16Array(0);
    this.pendingChars = 0;
  }

  start(): void {
    if (this.closed || this.timer !== null) return;
    this.started = performance.now();
    this.sent = 0;
    this.tick();
  }

  stop(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.clear();
    this.encoder.delete();
  }

  private tick(): void {
    if (this.closed) return;
    const due = Math.floor((performance.now() - this.started) / FRAME_MS) + 1;
    if (due - this.sent > MAX_LATE_FRAMES) this.sent = due - 1;
    while (!this.closed && this.sent < due) this.sendOne();
    if (this.closed) return;
    const next = this.started + this.sent * FRAME_MS;
    this.timer = setTimeout(() => {
      this.tick();
    }, Math.max(0, next - performance.now()));
  }

  private sendOne(): void {
    const frame = this.queue.shift();
    const marker = frame !== undefined && !this.speaking;
    this.speaking = frame !== undefined;
    const pcm = frame?.pcm ?? new Int16Array(FRAME);
    const timestamp = (this.sent * FRAME) >>> 0;
    this.sent += 1;
    const generation = this.generation;
    if (frame !== undefined) this.inFlight += 1;
    try {
      const sent = this.out.send(this.encoder.encode(bytesOf(pcm), FRAME), timestamp, marker);
      Promise.resolve(sent).then(() => {
        if (this.closed || generation !== this.generation || frame === undefined) return;
        this.inFlight -= 1;
        if (marker) this.onFirst?.();
        if (frame.chars > 0) this.out.played(frame.chars);
        if (!this.busy) this.onIdle?.();
      }).catch((err: unknown) => {
        if (!this.closed && generation === this.generation) this.failed(errMsg(err));
      });
    } catch (err) {
      if (!this.closed && generation === this.generation) this.failed(errMsg(err));
    }
  }

  private failed(reason: string): void {
    this.clear();
    log.warn({ reason }, 'voice: audio playback failed');
    this.onFailed?.(reason);
  }
}
