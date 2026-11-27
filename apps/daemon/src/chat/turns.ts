import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { chatLine, fitReply, turnEventOf, type ChatReply } from '@metro-labs/core/chat';
import { isRecord } from '@metro-labs/core/is-record';
import { errMsg, log } from '@metro-labs/core/log';
import { ApiError } from '@metro-labs/http/api-error';
import { CappedLines } from './lines.js';
import type { ChatSessions } from './sessions.js';
import { Turn } from './turn.js';

export const RUNNING_MAX = 3;
const KEEP_MS = 10 * 60_000;
const TURN_MAX_MS = 2 * 60 * 60_000;
const GRACE_MS = 15_000;
const LINE_MAX = 1024 * 1024;
const STDERR_KEPT = 2_000;
const DELIVERY_MS = 10 * 60_000;
const PAUSE_FIRST_MS = 3_000;
const PAUSE_MAX_MS = 60_000;
const PID_MAX = 4_194_304;
const START_FAILED = 'The agent could not start this reply.';
const ENDED_EARLY = 'The agent stopped before it finished this reply.';

export type ChatSignal = 'SIGTERM' | 'SIGKILL';

export interface ChatPids {
  pid: number;
  group: number | null;
}

export interface ChatRunnerDeps {
  spawn: () => ChildProcessWithoutNullStreams;
  signal: (child: ChildProcessWithoutNullStreams, pids: ChatPids | null, signal: ChatSignal) => void;
  sessions: ChatSessions;
  post: (chat: string, message: string, reply: ChatReply) => Promise<void>;
  refused?: (err: unknown) => boolean;
  now: () => number;
  pause?: (ms: number) => Promise<void>;
  graceMs?: number;
  turnMaxMs?: number;
}

interface TurnStart {
  id: string;
  chat: string;
  prompt: string;
}

interface Running {
  turn: Turn;
  child: ChildProcessWithoutNullStreams;
  pids: ChatPids | null;
  stopping: boolean;
  ending: boolean;
  exited: boolean;
  drained: boolean;
  timers: ReturnType<typeof setInterval>[];
  stderr: string;
}

const CLI_LINE = /^metro chat: [^\n]{0,300}$/;

const cliLines = (text: string): string[] => text.split('\n').filter((line) => CLI_LINE.test(line)).slice(-3);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const pidOf = (value: unknown): number | null => (typeof value === 'number' && Number.isInteger(value) && value > 1 && value <= PID_MAX ? value : null);

function pidsOf(value: Record<string, unknown>): ChatPids | null {
  const pid = pidOf(value.pid);
  return pid === null ? null : { pid, group: pidOf(value.group) };
}

export class ChatTurns {
  private readonly turns = new Map<string, Turn>();
  private readonly running = new Map<string, Running>();

  constructor(private readonly deps: ChatRunnerDeps) {}

  private get grace(): number {
    return this.deps.graceMs ?? GRACE_MS;
  }

  find(id: string): Turn | undefined {
    this.sweep();
    return this.turns.get(id);
  }

  start(input: TurnStart): Turn {
    this.sweep();
    const known = this.turns.get(input.id);
    if (known?.chat === input.chat && known.done && !this.running.has(known.id)) return this.again(known);
    const busy = [...this.running.values()];
    if (busy.some((r) => r.turn.chat === input.chat)) throw new ApiError('The agent is still answering in this chat. Wait for it, or stop it.', 409);
    if (busy.length >= RUNNING_MAX) throw new ApiError(`The agent is already answering ${String(RUNNING_MAX)} chats. Try again in a moment.`, 429);
    const child = this.deps.spawn();
    const turn = new Turn(input.id, input.chat, this.deps.now());
    const run: Running = { turn, child, pids: null, stopping: false, ending: false, exited: false, drained: false, timers: [], stderr: '' };
    this.turns.set(turn.id, turn);
    this.running.set(turn.id, run);
    this.wire(run);
    child.stdin.write(chatLine({ t: 'turn', prompt: input.prompt, resume: this.deps.sessions.of(input.chat) }));
    run.timers.push(setTimeout(() => { this.stop(turn.id); }, this.deps.turnMaxMs ?? TURN_MAX_MS));
    log.info({ chat: input.chat, turn: turn.id, running: this.running.size }, 'chat: a turn started');
    return turn;
  }

  stop(id: string): boolean {
    const run = this.running.get(id);
    if (run === undefined) return false;
    run.stopping = true;
    this.send(run, { t: 'stop' });
    this.end(run);
    return true;
  }

  answer(id: string, approval: string, allow: boolean): boolean {
    const run = this.running.get(id);
    if (run === undefined) return false;
    this.send(run, { t: 'answer', id: approval, allow });
    return true;
  }

  private again(turn: Turn): Turn {
    log.info({ chat: turn.chat, turn: turn.id, delivery: turn.delivery }, 'chat: this message was already answered here, so it is not run again');
    if (turn.delivery === 'failed') {
      turn.redelivering();
      this.deliverLogged(turn);
    }
    return turn;
  }

  private send(run: Running, value: Record<string, unknown>): void {
    if (run.child.stdin.writable) run.child.stdin.write(chatLine(value));
  }

  private end(run: Running): void {
    if (run.ending) return;
    run.ending = true;
    run.timers.push(setTimeout(() => { this.terminate(run); }, this.grace));
  }

  private terminate(run: Running): void {
    if (run.exited) return;
    log.info({ turn: run.turn.id, known: run.pids !== null }, 'chat: the turn did not end by itself, so it is asked to end');
    this.signal(run, 'SIGTERM');
    run.timers.push(
      setInterval(() => {
        if (run.exited) return;
        log.warn({ turn: run.turn.id }, 'chat: the turn did not end after SIGTERM, so it is killed');
        this.signal(run, 'SIGKILL');
      }, this.grace),
    );
  }

  private signal(run: Running, signal: ChatSignal): void {
    try {
      this.deps.signal(run.child, run.pids, signal);
    } catch (err) {
      log.warn({ err: errMsg(err), turn: run.turn.id, signal }, 'chat: a signal could not reach the turn, it is still running');
    }
  }

  private wire(run: Running): void {
    const reader = new CappedLines(LINE_MAX, (line) => { this.line(run, line); }, (bytes) => {
      log.warn({ turn: run.turn.id, bytes }, 'chat: a turn line was over the limit, so it was dropped');
    });
    run.child.stdout.on('data', (chunk: Buffer) => { reader.push(chunk); });
    run.child.stdout.on('end', () => {
      reader.end();
      this.drained(run);
    });
    run.child.stdout.on('error', (err) => {
      log.warn({ err: errMsg(err), turn: run.turn.id }, 'chat: the turn output failed');
      this.drained(run);
    });
    run.child.stderr.on('data', (chunk: Buffer) => {
      run.stderr = (run.stderr + chunk.toString('utf8')).slice(-STDERR_KEPT);
    });
    run.child.stdin.on('error', (err) => {
      log.debug({ err: errMsg(err), turn: run.turn.id }, 'chat: the turn input closed');
    });
    run.child.on('error', (err) => { this.failed(run, err); });
    run.child.on('exit', (code) => { this.exited(run, code); });
  }

  private failed(run: Running, err: Error): void {
    if (run.child.pid !== undefined) {
      log.warn({ err: errMsg(err), turn: run.turn.id }, 'chat: a signal could not reach the turn, it is still running');
      return;
    }
    log.warn({ err: errMsg(err), turn: run.turn.id }, 'chat: the turn could not start');
    this.settle(run, START_FAILED);
  }

  private exited(run: Running, code: number | null): void {
    run.exited = true;
    if (!run.turn.done && code !== 0) log.warn({ turn: run.turn.id, code, said: cliLines(run.stderr) }, 'chat: the turn ended early');
    if (!run.drained) run.timers.push(setTimeout(() => { this.held(run); }, this.grace));
    this.settleWhenDone(run);
  }

  private held(run: Running): void {
    log.warn({ turn: run.turn.id }, 'chat: the turn exited but its output is still held open, so what is left of it is killed');
    this.signal(run, 'SIGKILL');
    this.drained(run);
  }

  private drained(run: Running): void {
    run.drained = true;
    this.settleWhenDone(run);
  }

  private settleWhenDone(run: Running): void {
    if (run.exited && run.drained) this.settle(run, ENDED_EARLY);
  }

  private line(run: Running, text: string): void {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      log.debug({ turn: run.turn.id, length: text.length }, 'chat: a turn line was not JSON');
      return;
    }
    if (!isRecord(value)) return;
    if (value.t === 'pid') run.pids = pidsOf(value) ?? run.pids;
    else if (value.t === 'session' && typeof value.id === 'string') this.deps.sessions.keep(run.turn.chat, value.id);
    else this.event(run, value);
  }

  private event(run: Running, value: Record<string, unknown>): void {
    const event = turnEventOf(value);
    if (event === null) return;
    run.turn.apply(event, this.deps.now());
    if (event.t === 'done') this.end(run);
  }

  private settle(run: Running, failure: string): void {
    if (this.running.get(run.turn.id) !== run) return;
    this.running.delete(run.turn.id);
    for (const timer of run.timers) clearTimeout(timer);
    if (!run.turn.done) run.turn.finish(run.stopping ? 'stopped' : 'error', run.stopping ? null : failure, this.deps.now());
    log.info({ chat: run.turn.chat, turn: run.turn.id, state: run.turn.reply().state }, 'chat: a turn ended');
    this.deliverLogged(run.turn);
  }

  private deliverLogged(turn: Turn): void {
    this.deliver(turn).catch((err: unknown) => {
      log.warn({ err: errMsg(err), turn: turn.id }, 'chat: the reply could not be saved');
      turn.delivered(false, this.deps.now());
    });
  }

  private async deliver(turn: Turn): Promise<void> {
    const reply = fitReply(turn.reply());
    const deadline = this.deps.now() + DELIVERY_MS;
    for (let attempt = 1; ; attempt += 1) {
      try {
        await this.deps.post(turn.chat, turn.id, reply);
        turn.delivered(true, this.deps.now());
        return;
      } catch (err) {
        const refused = this.deps.refused?.(err) === true;
        log.warn({ err: errMsg(err), turn: turn.id, attempt, refused }, 'chat: metro.box did not take the reply');
        const wait = Math.min(PAUSE_FIRST_MS * 2 ** (attempt - 1), PAUSE_MAX_MS);
        if (refused || this.deps.now() + wait > deadline) break;
        await (this.deps.pause ?? sleep)(wait);
      }
    }
    turn.delivered(false, this.deps.now());
  }

  private sweep(): void {
    const cutoff = this.deps.now() - KEEP_MS;
    for (const [id, turn] of this.turns) if (!this.running.has(id) && turn.settledAt !== null && turn.settledAt < cutoff) this.turns.delete(id);
  }
}
