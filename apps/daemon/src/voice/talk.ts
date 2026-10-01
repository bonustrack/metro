import { log } from '@metro-labs/core/log';
import { downsample3, OpusIn, Player, type Playback } from './audio.js';
import type { CallApprovals } from './approvals.js';
import { Brain, type Thinking, type ToolAsk } from './brain.js';
import { Scribe, VAD_SILENCE_SECS } from './scribe.js';
import { Utterance } from './speech.js';
import { Chunker } from './speakable.js';
import { brainModel, languageOf, voiceIdOf, type VoiceConfig } from './store.js';

const BARGE_MIN_WORDS = 2;

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

const toolName = (tool: string): string => tool.split('__').pop() ?? tool;

const approvalNote = (tool: string, id: string): string =>
  `[The owner was asked in the chat of this call to approve ${toolName(tool)}; they answer "yes ${id}" or "no ${id}" there. Unless you already said so, tell the caller in one short sentence that it waits for their answer in the chat.]`;

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
  private askedAt: number | null = null;
  private saidAt: number | null = null;
  private lastHeardAt: number | null = null;
  private readonly delays: number[] = [];
  private live = false;
  private finished = false;
  private spoke = false;

  constructor(
    private readonly cfg: VoiceConfig,
    out: (opus: Buffer, timestamp: number, marker: boolean) => void,
    private readonly ended: (reason: string) => void,
    private readonly approvals: CallApprovals,
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
    this.scribe = new Scribe(cfg.apiKey, languageOf(cfg), {
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

  finish(): void {
    if (this.finished) return;
    this.finished = true;
    this.live = false;
    this.approvals.close();
    this.player.stop();
    this.scribe.close();
    this.reply?.utterance.abort();
    this.spare?.abort();
    this.opus.close();
    this.brain.close();
    this.logReplyTime();
  }

  turnStarted(): void {
    this.muted = false;
    if (this.finished) return;
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
    if (this.muted || reply === null) return;
    reply.firstText ??= performance.now();
    this.speak(reply, reply.chunker.add(delta));
  }

  tool(name: string): void {
    log.info({ tool: name }, 'voice: the agent uses a tool during the call');
    if (this.reply !== null && !this.muted) this.speak(this.reply, this.reply.chunker.flush());
  }

  turnEnded(): void {
    const reply = this.reply;
    if (reply === null || this.muted) return;
    this.speak(reply, reply.chunker.flush());
    reply.utterance.end();
    log.info(
      { firstText: since(reply.askedAt, reply.firstText), firstAudio: since(reply.askedAt, reply.firstAudio), vadSilenceMs: VAD_SILENCE_SECS * 1000 },
      'voice: reply timing in ms from the caller’s words being committed',
    );
  }

  asked(ask: ToolAsk): void {
    const id = this.finished ? null : this.approvals.ask(ask, (behavior) => {
      this.brain.answer(ask, behavior);
    });
    if (id === null) {
      this.brain.answer(ask, 'deny');
      return;
    }
    log.info({ tool: ask.tool, worker: ask.fromWorker }, 'voice: a tool waits for the owner’s approval in the chat of the call');
    this.brain.tell(approvalNote(ask.tool, id));
  }

  exited(reason: string): void {
    log.warn({ reason }, 'voice: the agent session for the call ended');
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

  private logReplyTime(): void {
    if (this.delays.length === 0) return;
    const sorted = [...this.delays].sort((a, b) => a - b);
    log.info({ middleMs: Math.round(sorted[Math.floor(sorted.length / 2)] ?? 0), replies: sorted.length }, 'voice: reply time of the call, from the caller’s last word heard to the first reply audio sent');
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
    if (this.interrupts(text)) this.cutOff();
    const note = this.cut;
    const now = this.muted;
    this.cut = null;
    this.askedAt = performance.now();
    this.saidAt = this.lastHeardAt ?? this.askedAt;
    this.lastHeardAt = null;
    this.brain.tell(note === null ? text : `${note}\n${text}`, now);
  }
}
