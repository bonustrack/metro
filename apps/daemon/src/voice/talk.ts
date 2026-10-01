import { log } from '@metro-labs/core/log';
import { downsample3, OpusIn, Player, type Playback } from './audio.js';
import { Brain, type Thinking } from './brain.js';
import { Scribe, VAD_SILENCE_SECS } from './scribe.js';
import { Utterance } from './speech.js';
import { Chunker } from './speakable.js';
import { brainModel, voiceIdOf, type VoiceConfig } from './store.js';

const BARGE_MIN_CHARS = 4;
const NOTES_WAIT_MS = 60_000;
const NOTES_PROMPT =
  '[The call has ended. Write short call notes for the chat: what was discussed, what was decided and what you will follow up on. Plain text, at most 6 short lines, no title and no greeting. Reply with the notes only.]';

interface Reply {
  utterance: Utterance;
  said: string;
  heard: number;
  chunker: Chunker;
  askedAt: number | null;
  firstText: number | null;
  firstAudio: number | null;
}

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
  private notes: ((text: string) => void) | null = null;
  private notesStarted = false;
  private live = false;
  private finished = false;
  private heardCaller = false;

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
    this.spare = new Utterance(cfg.apiKey, voiceIdOf(cfg));
  }

  prime(context: string): void {
    this.busy = true;
    this.brain.tell(context);
  }

  connect(): void {
    this.live = true;
    this.spare ??= new Utterance(this.cfg.apiKey, voiceIdOf(this.cfg));
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
    this.reply = { utterance: this.takeUtterance(), said: '', heard: 0, chunker: new Chunker(), askedAt: this.askedAt, firstText: null, firstAudio: null };
    this.askedAt = null;
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
    const ready = this.spare?.usable === true ? this.spare : new Utterance(this.cfg.apiKey, voiceIdOf(this.cfg));
    this.spare = this.live ? new Utterance(this.cfg.apiKey, voiceIdOf(this.cfg)) : null;
    if (ready === this.spare) this.spare = null;
    const reply = (): Reply | null => this.reply;
    ready.attach({
      audio: (pcm, chars) => {
        const current = reply();
        if (current?.utterance !== ready) return;
        current.firstAudio ??= performance.now();
        this.player.push(pcm, chars);
      },
      done: () => {
        this.player.finish();
      },
    });
    return ready;
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

  private firstPlayed(): void {
    const reply = this.reply;
    if (reply?.askedAt != null) log.info({ firstPlayed: since(reply.askedAt, performance.now()) }, 'voice: first reply audio sent to the caller');
  }

  private partial(text: string): void {
    if (text.replace(/\s/g, '').length < BARGE_MIN_CHARS || this.muted) return;
    if (!this.player.busy && !this.busy) return;
    const reply = this.reply;
    this.cut = heardNote(reply);
    reply?.utterance.abort();
    this.player.clear();
    this.muted = true;
  }

  private committed(text: string): void {
    this.heardCaller = true;
    const note = this.cut;
    const now = this.busy || note !== null;
    this.cut = null;
    if (now && !this.muted) {
      this.reply?.utterance.abort();
      this.player.clear();
      this.muted = true;
    }
    this.askedAt = performance.now();
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
