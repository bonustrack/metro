import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { errMsg, log } from '@metro-labs/core/log';
import { isRecord } from '@metro-labs/core/is-record';
import { drainLines } from '@metro-labs/core/trains/protocol';
import { asAgent } from '../agent-user/user.js';
import { metroCli } from '../claude/session.js';

const CLOSE_GRACE_MS = 10_000;
const DENIED = 'The owner did not approve this.';

export interface ToolAsk {
  requestId: string;
  tool: string;
  input: Record<string, unknown>;
  description: string;
  fromWorker: boolean;
}

export interface Thinking {
  turnStarted(): void;
  text(delta: string): void;
  tool(name: string): void;
  turnEnded(): void;
  asked(ask: ToolAsk): void;
  exited(reason: string): void;
}

const record = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {});
const str = (value: unknown): string => (typeof value === 'string' ? value : '');

export function toolAsk(msg: Record<string, unknown>): ToolAsk | null {
  const request = record(msg.request);
  const requestId = str(msg.request_id);
  if (request.subtype !== 'can_use_tool' || requestId === '' || str(request.tool_name) === '') return null;
  return {
    requestId,
    tool: str(request.tool_name),
    input: record(request.input),
    description: str(request.description) || str(request.decision_reason),
    fromWorker: str(request.agent_id) !== '',
  };
}

function streamEvent(msg: Record<string, unknown>, mind: Thinking): void {
  if (msg.parent_tool_use_id !== null && msg.parent_tool_use_id !== undefined) return;
  const event = record(msg.event);
  const delta = record(event.delta);
  if (event.type === 'content_block_delta' && delta.type === 'text_delta' && typeof delta.text === 'string') mind.text(delta.text);
  const block = record(event.content_block);
  if (event.type === 'content_block_start' && block.type === 'tool_use') mind.tool(typeof block.name === 'string' ? block.name : 'tool');
}

function startBrain(model: string): ChildProcessWithoutNullStreams {
  const [command = 'metro', ...args] = metroCli(['voice', '--model', model]);
  const [file, argv] = asAgent(command, args);
  return spawn(file, argv, { stdio: ['pipe', 'pipe', 'pipe'], cwd: '/' });
}

export class Brain {
  private readonly child: ChildProcessWithoutNullStreams;
  private out = '';
  private gone = false;
  private closing = false;
  private killTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(model: string, private readonly mind: Thinking, launch = startBrain) {
    this.child = launch(model);
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => {
      this.out = drainLines('voice-brain', this.out + chunk, (line) => {
        this.read(line);
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

  tell(text: string, now = false): void {
    const message = { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, session_id: '' };
    this.write(now ? { ...message, priority: 'now' } : message);
  }

  answer(ask: ToolAsk, behavior: 'allow' | 'deny'): void {
    const response = behavior === 'allow' ? { behavior, updatedInput: ask.input } : { behavior, message: DENIED };
    this.write({ type: 'control_response', response: { subtype: 'success', request_id: ask.requestId, response } });
  }

  close(): void {
    if (this.gone || this.closing) return;
    this.closing = true;
    this.child.stdin.end();
    this.child.kill('SIGTERM');
    this.killTimer = setTimeout(() => {
      if (!this.gone) this.child.kill('SIGKILL');
    }, CLOSE_GRACE_MS);
    this.killTimer.unref();
  }

  private write(message: Record<string, unknown>): void {
    if (!this.gone && !this.closing && this.child.stdin.writable) this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private read(line: string): void {
    if (this.closing || this.gone) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    const msg = record(parsed);
    if (msg.type === 'system' && msg.subtype === 'init') this.mind.turnStarted();
    else if (msg.type === 'stream_event') streamEvent(msg, this.mind);
    else if (msg.type === 'result') this.mind.turnEnded();
    else if (msg.type === 'control_request') this.control(msg);
  }

  private control(msg: Record<string, unknown>): void {
    const ask = toolAsk(msg);
    if (ask !== null) {
      this.mind.asked(ask);
      return;
    }
    const subtype = str(record(msg.request).subtype);
    log.warn({ subtype }, 'voice: the agent session asked for something the call does not handle');
    this.write({ type: 'control_response', response: { subtype: 'error', request_id: str(msg.request_id), error: `not supported on a voice call: ${subtype}` } });
  }

  private exit(reason: string): void {
    if (this.gone) return;
    this.gone = true;
    clearTimeout(this.killTimer);
    if (!this.closing) this.mind.exited(reason);
  }
}
