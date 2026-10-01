import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { errMsg, log } from '@metro-labs/core/log';
import { isRecord } from '@metro-labs/core/is-record';
import { drainLines } from '@metro-labs/core/trains/protocol';
import { asAgent } from '../agent-user/user.js';
import { metroCli } from '../claude/session.js';

const CLOSE_GRACE_MS = 10_000;

export interface Thinking {
  turnStarted(): void;
  text(delta: string): void;
  tool(name: string): void;
  turnEnded(text: string): void;
  exited(reason: string): void;
}

const record = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {});

function streamEvent(msg: Record<string, unknown>, mind: Thinking): void {
  if (msg.parent_tool_use_id !== null && msg.parent_tool_use_id !== undefined) return;
  const event = record(msg.event);
  const delta = record(event.delta);
  if (event.type === 'content_block_delta' && delta.type === 'text_delta' && typeof delta.text === 'string') mind.text(delta.text);
  const block = record(event.content_block);
  if (event.type === 'content_block_start' && block.type === 'tool_use') mind.tool(typeof block.name === 'string' ? block.name : 'tool');
}

function readBrainLine(line: string, mind: Thinking): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return;
  }
  const msg = record(parsed);
  if (msg.type === 'system' && msg.subtype === 'init') mind.turnStarted();
  else if (msg.type === 'stream_event') streamEvent(msg, mind);
  else if (msg.type === 'result') mind.turnEnded(typeof msg.result === 'string' ? msg.result : '');
}

export class Brain {
  private readonly child: ChildProcessWithoutNullStreams;
  private out = '';
  private gone = false;

  constructor(model: string, private readonly mind: Thinking) {
    const [command = 'metro', ...args] = metroCli(['voice', '--model', model]);
    const [file, argv] = asAgent(command, args);
    this.child = spawn(file, argv, { stdio: ['pipe', 'pipe', 'pipe'], cwd: '/' });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => {
      this.out = drainLines('voice-brain', this.out + chunk, (line) => {
        readBrainLine(line, this.mind);
      });
    });
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk: string) => {
      log.debug({ text: chunk.slice(0, 500) }, 'voice: brain stderr');
    });
    this.child.stdin.on('error', (err) => {
      log.debug({ err: errMsg(err) }, 'voice: brain stdin closed');
    });
    this.child.on('error', (err) => {
      this.exit(`could not start: ${errMsg(err)}`);
    });
    this.child.on('exit', (code, signal) => {
      this.exit(`exited (${String(code ?? signal)})`);
    });
  }

  get alive(): boolean {
    return !this.gone;
  }

  tell(text: string, now = false): void {
    if (this.gone) return;
    const message = { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, session_id: '' };
    this.child.stdin.write(`${JSON.stringify(now ? { ...message, priority: 'now' } : message)}\n`);
  }

  close(): void {
    if (this.gone) return;
    this.child.stdin.end();
    setTimeout(() => {
      if (!this.gone) this.child.kill('SIGKILL');
    }, CLOSE_GRACE_MS).unref();
  }

  private exit(reason: string): void {
    if (this.gone) return;
    this.gone = true;
    this.mind.exited(reason);
  }
}
