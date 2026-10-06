import type { SpeechStatus } from '@metro-labs/core/call';
import { errMsg, log } from '@metro-labs/core/log';
import { Player, type Playback } from './audio.js';
import { Utterance } from './speech.js';
import type { SharedSpeechAction } from './shared.js';
import { voiceIdOf, type VoiceConfig } from './store.js';

const MAX_QUEUED = 8;
const MAX_TEXT = 32_000;
const SPEECH_MS = 60_000;

type Speech = Pick<Utterance, 'attach' | 'say' | 'end' | 'abort'>;
type MakeSpeech = (failed: (reason: string) => void) => Speech;

interface Queued {
  action: SharedSpeechAction;
  queuedAt: number;
}

interface Playing extends Queued {
  utterance: Speech | null;
  timer: ReturnType<typeof setTimeout>;
  synthesized: boolean;
  started: boolean;
  synthesisStartedAt: number;
  firstAudioAt: number | null;
  markedFrameResolvedAt: number | null;
}

export class SpeechQueue {
  private readonly player: Player;
  private readonly waiting: Queued[] = [];
  private current: Playing | null = null;
  private live = false;
  private closed = false;
  private onFailed: () => void = () => undefined;

  constructor(
    cfg: VoiceConfig,
    send: Playback['send'],
    private readonly makeSpeech: MakeSpeech = (failed) => new Utterance(cfg.apiKey, voiceIdOf(cfg), failed),
    private readonly timeoutMs = SPEECH_MS,
  ) {
    this.player = new Player({
      send: (opus, timestamp, marker) => {
        if (this.current !== null && !this.valid(this.current)) return;
        return send(opus, timestamp, marker);
      },
      played: () => undefined,
    });
    this.player.whenFirstPlayed(() => {
      const current = this.current;
      if (current === null || current.started) return;
      current.started = true;
      current.markedFrameResolvedAt = Date.now();
      current.action.status('started');
    });
    this.player.whenIdle(() => {
      this.drained();
    });
    this.player.whenFailed((reason) => {
      this.fail(reason);
    });
  }

  get busy(): boolean {
    return this.player.busy;
  }

  whenFailed(failed: () => void): void {
    this.onFailed = failed;
  }

  enqueue(action: SharedSpeechAction): boolean {
    if (this.closed || action.text.trim() === '' || action.text.length > MAX_TEXT) return false;
    if (this.waiting.length + (this.current === null ? 0 : 1) >= MAX_QUEUED || !action.isValid()) return false;
    this.waiting.push({ action, queuedAt: Date.now() });
    queueMicrotask(() => {
      this.next();
    });
    return true;
  }

  connect(): void {
    if (this.closed || this.live) return;
    this.live = true;
    this.player.start();
    this.next();
  }

  cancel(): void {
    const waiting = this.waiting.splice(0);
    this.settle('interrupted');
    for (const queued of waiting) {
      this.report(queued, 'interrupted');
      queued.action.status('interrupted');
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.live = false;
    this.cancel();
    this.player.stop();
  }

  private next(): void {
    if (!this.live || this.closed || this.current !== null) return;
    const queued = this.waiting.shift();
    if (queued === undefined) return;
    const { action } = queued;
    if (!action.isValid()) {
      this.report(queued, 'failed');
      action.status('failed');
      this.next();
      return;
    }
    const playing: Playing = {
      ...queued, utterance: null, synthesized: false, started: false,
      synthesisStartedAt: Date.now(), firstAudioAt: null, markedFrameResolvedAt: null,
      timer: setTimeout(() => {
        if (this.current === playing) this.fail('speech timed out');
      }, this.timeoutMs),
    };
    this.current = playing;
    try {
      const utterance = this.makeSpeech((reason) => {
        if (this.current === playing) this.fail(reason);
      });
      if (this.current !== playing) {
        utterance.abort();
        return;
      }
      playing.utterance = utterance;
      utterance.attach({
        audio: (pcm, chars) => {
          if (this.current === playing && pcm.length > 0) playing.firstAudioAt ??= Date.now();
          if (!this.valid(playing)) return;
          this.player.push(pcm, chars);
        },
        done: () => {
          if (!this.valid(playing)) return;
          playing.synthesized = true;
          this.player.finish();
          this.drained();
        },
      });
      utterance.say(action.text);
      utterance.end();
    } catch (err) {
      if (this.current === playing) this.fail(errMsg(err));
    }
  }

  private valid(playing: Playing): boolean {
    if (this.closed || this.current !== playing) return false;
    if (playing.action.isValid()) return true;
    this.settle('failed');
    return false;
  }

  private drained(): void {
    const current = this.current;
    if (current === null || !current.synthesized || this.player.busy) return;
    if (current.started) this.settle('completed');
    else this.fail('no audio received');
  }

  private fail(reason: string): void {
    log.warn({ reason }, 'voice: queued speech failed');
    this.settle('failed');
    this.onFailed();
  }

  private report(queued: Queued, status: SpeechStatus, playing?: Playing): void {
    log.info({
      actionId: queued.action.actionId, status, queuedAt: queued.queuedAt,
      synthesisStartedAt: playing?.synthesisStartedAt ?? null,
      firstAudioAt: playing?.firstAudioAt ?? null,
      markedFrameResolvedAt: playing?.markedFrameResolvedAt ?? null,
      settledAt: Date.now(),
    }, 'voice: speech timing');
  }

  private settle(status: SpeechStatus): void {
    const current = this.current;
    this.current = null;
    this.player.clear();
    if (current !== null) {
      clearTimeout(current.timer);
      current.utterance?.abort();
      this.report(current, status, current);
      current.action.status(status);
    }
    queueMicrotask(() => {
      this.next();
    });
  }
}
