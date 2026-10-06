import { randomUUID } from 'node:crypto';
import { downsample3, OpusIn, type Playback } from './audio.js';
import { Scribe, type Heard } from './scribe.js';
import type { SharedCallTransport, SharedSpeechAction } from './shared.js';
import { SpeechQueue } from './speech-queue.js';
import { languageOf, type VoiceConfig } from './store.js';

const BARGE_MIN_WORDS = 2;
const wordsIn = (text: string): number => text.split(/\s+/).filter((word) => /\p{L}/u.test(word)).length;

type MakeScribe = (heard: Heard) => Pick<Scribe, 'send' | 'close'>;

export class SharedTalk implements SharedCallTransport {
  private readonly opus = new OpusIn();
  private readonly scribe: Pick<Scribe, 'send' | 'close'>;
  private readonly speech: SpeechQueue;
  private closed = false;

  constructor(
    cfg: VoiceConfig,
    send: Playback['send'],
    private readonly ended: (reason: string) => void,
    heard: (text: string, sourceId: string) => void,
    makeScribe: MakeScribe = (events) => new Scribe(cfg.apiKey, languageOf(cfg), events),
    speech = new SpeechQueue(cfg, send),
  ) {
    this.speech = speech;
    this.speech.whenFailed(() => {
      this.stop('speech is unavailable');
    });
    this.scribe = makeScribe({
      partial: (text) => {
        this.barge(text);
      },
      committed: (text) => {
        if (this.closed || text.trim() === '') return;
        this.barge(text);
        heard(text, randomUUID());
      },
      failed: (reason) => {
        if (!this.closed) ended(reason);
      },
    });
  }

  enqueue(action: SharedSpeechAction): boolean {
    return !this.closed && this.speech.enqueue(action);
  }

  cancel(): void {
    this.speech.cancel();
  }

  terminate(): void {
    this.stop('the shared conversation ended');
  }

  connect(): void {
    if (!this.closed) this.speech.connect();
  }

  hear(packet: Buffer): void {
    if (this.closed) return;
    const pcm = this.opus.decode(packet);
    if (pcm !== null) this.scribe.send(downsample3(pcm));
  }

  finish(): void {
    if (this.closed) return;
    this.closed = true;
    this.speech.close();
    this.scribe.close();
    this.opus.close();
  }

  private stop(reason: string): void {
    if (this.closed) return;
    this.finish();
    this.ended(reason);
  }

  private barge(text: string): void {
    if (!this.closed && this.speech.busy && wordsIn(text) >= BARGE_MIN_WORDS) this.speech.cancel();
  }
}
