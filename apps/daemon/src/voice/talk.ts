import { log } from '@metro-labs/core/log';
import { downsample3, OpusIn, Player, type Playback } from './audio.js';
import { Brain, type Thinking } from './brain.js';
import { Scribe, VAD_SILENCE_SECS } from './scribe.js';
import { Utterance } from './speech.js';
import { Chunker } from './speakable.js';
import { brainModel, voiceIdOf, type VoiceConfig } from './store.js';

const BARGE_MIN_WORDS = 2;
const NOTES_WAIT_MS = 60_000;
const NOTES_PROMPT =
  '[The call has ended. Write short call notes for the chat: what was discussed, what was decided and what you will follow up on. Plain text, at most 6 short lines, no title and no greeting. Reply with the notes only.]';

interface Reply {
  utterance: Utterance;
  said: string;
  heard: number;
  chunker: Chunker;
  askedAt: number | null;
  saidAt: number | null;
  firstText: number | null;
  firstAudio: number | null;
  firstPlayed: number | null;
}

const wordsIn = (text: string): number => text.split(/\s+/).filter((word) => /\p{L}/u.test(word)).length;

const since = (start: number | null, at: number | null): number | null =>
  start === null || at === null ? null : Math.round(at - start);

function heardNote(reply: Reply | null): string | null {
  if (reply === null || reply.said.trim() === '' || reply.heard >= reply.said.trim().length - 2) return null;
  const part = reply.said.slice(0, reply.heard).trim();
  return part === ''
    ? '[The caller interrupted you before hearing your reply.]'
    : `[The caller interrupted you. They heard only: "${part}". The rest of your reply was not heard.]`;
}

export class Talk implements Thinking {
  private readonly brain: Brain;
  private readonly scribe: Scribe;
  private readonly opus = new OpusIn();
  private readonly player: Player;
  private spare: Utterance | null = null;
  private reply: Reply | null = null;
  private cut: string | null = null;
  private muted = false;
  private busy = false;
  private askedAt: number | null = null;
  private saidAt: number | null = null;
  private lastHeardAt: number | null = null;
  private readonly delays: number[] = [];
  private notes: ((text: string) => void) | null = null;
  private notesStarted = false;
  private live = false;
  private finished = false;
  private heardCaller = false;
  private spoke = false;

  constructor(
    private readonly cfg: VoiceConfig,
    out: (opus: Buffer, timestamp: number, marker: boolean) => void,
    private readonly ended: (reason: string) => void,
  ) {
    const playback: Playback = {
      send: out,
      played: (chars) => {
        this.played(chars);
      },
    };
    this.player = new Player(playback);
    this.player.whenFirstPlayed(() => {
      this.firstPlayed();
    });
    this.brain = new Brain(brainModel(cfg), this);
    this.scribe = new Scribe(cfg.apiKey, {
      partial: (text) => {
        this.partial(text);
      },
      committed: (text) => {
        this.committed(text);
      },
      failed: (reason) => {
        this.ended(reason);
      },
    });
    this.spare = this.utterance();
  }

  prime(context: string): void {
    this.busy = true;
    this.brain.tell(context);
  }

  connect(): void {
    this.live = true;
    this.spare ??= this.utterance();
    this.player.start();
  }

  hear(packet: Buffer): void {
    if (this.finished) return;
    const pcm = this.opus.decode(packet);
    if (pcm !== null) this.scribe.send(downsample3(pcm));
  }

  async finish(): Promise<string | null> {
    if (this.finished) return null;
    this.finished = true;
    this.live = false;
    this.player.stop();
    this.scribe.close();
    this.reply?.utterance.abort();
    this.spare?.abort();
    this.opus.close();
    const notes = this.heardCaller && this.brain.alive ? await this.callNotes() : null;
    this.brain.close();
    return notes;
  }

  turnStarted(): void {
    this.muted = false;
    this.busy = true;
    if (this.notes !== null) this.notesStarted = true;
    if (this.notes !== null || this.finished) return;
    this.reply = {
      utterance: this.takeUtterance(),
      said: '',
      heard: 0,
      chunker: new Chunker(),
      askedAt: this.askedAt,
      saidAt: this.saidAt,
      firstText: null,
      firstAudio: null,
      firstPlayed: null,
    };
    this.askedAt = null;
    this.saidAt = null;
  }

  text(delta: string): void {
    const reply = this.reply;
    if (this.muted || reply === null || this.notes !== null) return;
    reply.firstText ??= performance.now();
    this.speak(reply, reply.chunker.add(delta));
  }

  tool(name: string): void {
    log.info({ tool: name }, 'voice: the agent uses a tool during the call');
    if (this.reply !== null && !this.muted) this.speak(this.reply, this.reply.chunker.flush());
  }

  turnEnded(text: string): void {
    this.busy = false;
    const notes = this.notes;
    if (notes !== null) {
      if (!this.notesStarted) return;
      this.notes = null;
      notes(text);
      return;
    }
    const reply = this.reply;
    if (reply === null || this.muted) return;
    this.speak(reply, reply.chunker.flush());
    reply.utterance.end();
    log.info(
      { firstText: since(reply.askedAt, reply.firstText), firstAudio: since(reply.askedAt, reply.firstAudio), vadSilenceMs: VAD_SILENCE_SECS * 1000 },
      'voice: reply timing in ms from the caller’s words being committed',
    );
  }

  exited(reason: string): void {
    log.warn({ reason }, 'voice: the agent session for the call ended');
    this.notes?.('');
    this.notes = null;
    this.ended(`agent session ${reason}`);
  }

  private takeUtterance(): Utterance {
    const ready = this.spare?.usable === true ? this.spare : this.utterance();
    this.spare = this.live ? this.utterance() : null;
    if (ready === this.spare) this.spare = null;
    const reply = (): Reply | null => this.reply;
    ready.attach({
      audio: (pcm, chars) => {
        const current = reply();
        if (current?.utterance !== ready) return;
        this.spoke = true;
        current.firstAudio ??= performance.now();
        this.player.push(pcm, chars);
      },
      done: () => {
        this.player.finish();
      },
    });
    return ready;
  }

  private utterance(): Utterance {
    return new Utterance(this.cfg.apiKey, voiceIdOf(this.cfg), (reason) => {
      log.warn({ reason }, 'voice: text to speech gave no audio');
      if (!this.spoke && !this.finished) this.ended(`ElevenLabs could not speak (${reason})`);
    });
  }

  private speak(reply: Reply, parts: string[]): void {
    for (const part of parts) {
      reply.said += `${part} `;
      reply.utterance.say(part);
    }
  }

  private played(chars: number): void {
    if (this.reply !== null) this.reply.heard += chars;
  }

  get replyTime(): string | null {
    if (this.delays.length === 0) return null;
    const sorted = [...this.delays].sort((a, b) => a - b);
    const middle = sorted[Math.floor(sorted.length / 2)] ?? 0;
    return `Reply time, from your last word heard to my first word sent: about ${(middle / 1000).toFixed(1)} s (middle of ${String(sorted.length)}).`;
  }

  private firstPlayed(): void {
    const reply = this.reply;
    if (reply?.firstPlayed !== null || reply.saidAt === null) return;
    reply.firstPlayed = performance.now();
    this.delays.push(reply.firstPlayed - reply.saidAt);
    log.info({ fromLastWord: since(reply.saidAt, reply.firstPlayed), fromCommit: since(reply.askedAt, reply.firstPlayed) }, 'voice: first reply audio sent to the caller, in ms');
  }

  private interrupts(text: string): boolean {
    return !this.muted && this.player.busy && wordsIn(text) >= BARGE_MIN_WORDS;
  }

  private cutOff(): void {
    this.cut = heardNote(this.reply);
    this.reply?.utterance.abort();
    this.player.clear();
    this.muted = true;
  }

  private partial(text: string): void {
    if (text !== '') this.lastHeardAt = performance.now();
    if (this.interrupts(text)) this.cutOff();
  }

  private committed(text: string): void {
    this.heardCaller = true;
    if (this.interrupts(text)) this.cutOff();
    const note = this.cut;
    const now = this.muted;
    this.cut = null;
    this.askedAt = performance.now();
    this.saidAt = this.lastHeardAt ?? this.askedAt;
    this.lastHeardAt = null;
    this.busy = true;
    this.brain.tell(note === null ? text : `${note}\n${text}`, now);
  }

  private callNotes(): Promise<string | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.notes = null;
        resolve(null);
      }, NOTES_WAIT_MS);
      this.notesStarted = false;
      this.notes = (text) => {
        clearTimeout(timer);
        resolve(text.trim() === '' ? null : text.trim());
      };
      this.brain.tell(NOTES_PROMPT, this.busy);
    });
  }
}
