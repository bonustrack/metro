// Claude Code agent adapter. Spawns `claude -p --output-format stream-json
// --include-partial-messages --verbose` per turn, parses the line-delimited
// JSON event stream, and exposes the same `Agent` surface as codex.ts.
//
// Unlike codex (long-running app-server daemon), Claude Code has no daemon
// mode — each turn is a fresh subprocess. Session continuity is achieved
// by passing the same uuid via `--session-id` for the first turn and
// `--resume` for every subsequent turn.

import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { errMsg, log } from '../log.js';
import { STATE_DIR } from '../paths.js';
import type { Agent, AgentTurnCallbacks } from './types.js';

// Persisted across metro restarts. Without this, the first message after
// a restart would call `claude -p --session-id <uuid>` on an existing
// session, which fails silently (no result event) and leaves the user
// staring at "Thinking…" forever. Codex doesn't have this problem
// because codex app-server is the state authority and reads its on-disk
// thread store on spawn.
const STARTED_FILE = join(STATE_DIR, 'claude-sessions.json');

function loadStarted(): Set<string> {
  if (!existsSync(STARTED_FILE)) return new Set();
  try {
    return new Set(JSON.parse(readFileSync(STARTED_FILE, 'utf8')) as string[]);
  } catch (err) {
    log.warn({ err: errMsg(err), path: STARTED_FILE }, 'claude agent: started cache read failed; treating as empty');
    return new Set();
  }
}

export class ClaudeAgent implements Agent {
  // Threads that have had at least one turn run (so `--session-id` was
  // already consumed and subsequent turns must use `--resume`).
  private started = loadStarted();
  private children = new Set<ChildProcess>();

  private persistStarted(): void {
    try {
      writeFileSync(STARTED_FILE, JSON.stringify([...this.started]));
    } catch (err) {
      log.warn({ err: errMsg(err), path: STARTED_FILE }, 'claude agent: started cache write failed');
    }
  }

  async start(): Promise<void> {
    // No daemon to bring up — sanity-check that `claude` is on PATH so we
    // fail loud at boot rather than on the first inbound message.
    await new Promise<void>((resolve, reject) => {
      const c = spawn('claude', ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      c.stdout.on('data', d => { out += String(d); });
      c.on('error', reject);
      c.on('exit', code => {
        if (code === 0) {
          log.info({ version: out.trim() }, 'claude agent: ready');
          resolve();
        } else reject(new Error(`claude --version exited with ${code}`));
      });
    });
  }

  async stop(): Promise<void> {
    for (const c of this.children) {
      try { c.kill('SIGTERM'); } catch { /* ignore */ }
    }
    this.children.clear();
  }

  async createThread(): Promise<string> {
    // Pre-allocate a uuid so the Discord thread can be named with it before
    // the first turn runs. Claude Code accepts any valid uuid via
    // `--session-id` and persists the session under that id.
    const id = randomUUID();
    log.info({ thread: id }, 'claude agent: thread allocated');
    return id;
  }

  async sendTurn(threadId: string, text: string, callbacks: AgentTurnCallbacks): Promise<void> {
    const args = [
      '-p',
      '--output-format', 'stream-json',
      '--include-partial-messages',
      '--verbose',
    ];
    if (this.started.has(threadId)) args.push('--resume', threadId);
    else args.push('--session-id', threadId);
    args.push(text);

    const child = spawn('claude', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.children.add(child);
    log.debug({ thread: threadId, args: args.slice(0, -1) }, 'claude agent: turn started');

    const session = new TurnSession(callbacks);
    let buffer = '';
    child.stdout?.on('data', d => {
      buffer += String(d);
      let nl: number;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        try {
          session.handle(JSON.parse(line));
        } catch (err) {
          log.warn({ err: errMsg(err) }, 'claude agent: malformed event');
        }
      }
    });
    child.stderr?.on('data', d => log.trace({ src: 'claude-stderr' }, String(d).trim()));
    child.on('exit', code => {
      this.children.delete(child);
      if (!this.started.has(threadId)) {
        this.started.add(threadId);
        this.persistStarted();
      }
      // If the subprocess exits without a `result` event (crash, OOM, kill),
      // surface that as an error so the orchestrator unsticks the thread.
      if (!session.done) {
        if (code === 0) session.fireComplete();
        else session.fireError(new Error(`claude exited with code ${code}`));
      }
    });
    child.on('error', err => {
      this.children.delete(child);
      if (!session.done) session.fireError(err);
    });
  }
}

// Owns the once-only firing of onComplete/onError and the per-index tool
// tracking so block_stop events can fire onToolEnd correctly.
class TurnSession {
  done = false;
  // Show "Thinking…" until the first real text/tool event lands. Claude
  // Code doesn't emit a separate reasoning event the way codex does, so
  // without this the user sees nothing while the agent is still on its
  // initial API call — feels like the bot's frozen.
  private thinking = true;
  // Track which content-block indexes belong to tool_use vs text so
  // block_stop fires onToolEnd only for tool blocks.
  private tools = new Map<number, string>();

  constructor(private cb: AgentTurnCallbacks) {
    cb.onToolStart({ kind: 'thinking', name: 'Thinking…', transient: true });
  }

  fireComplete(): void {
    if (this.done) return;
    this.done = true;
    this.clearThinking();
    this.cb.onComplete();
  }

  fireError(err: Error): void {
    if (this.done) return;
    this.done = true;
    this.clearThinking();
    this.cb.onError(err);
  }

  private clearThinking(): void {
    if (!this.thinking) return;
    this.thinking = false;
    this.cb.onToolEnd('thinking');
  }

  handle(ev: ClaudeEvent): void {
    if (ev.type === 'result') {
      if (ev.is_error) this.fireError(new Error(typeof ev.result === 'string' ? ev.result : 'claude error'));
      else this.fireComplete();
      return;
    }
    if (ev.type !== 'stream_event' || !ev.event) return;
    const e = ev.event;
    if (e.type === 'content_block_start' && e.content_block?.type === 'tool_use') {
      this.clearThinking();
      const kind = e.content_block.name ?? 'tool';
      this.tools.set(e.index ?? -1, kind);
      const { name, detail } = summarizeTool(e.content_block.name, e.content_block.input);
      this.cb.onToolStart({ kind, name, detail });
    } else if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta') {
      this.clearThinking();
      this.cb.onDelta(e.delta.text ?? '');
    } else if (e.type === 'content_block_stop') {
      const kind = this.tools.get(e.index ?? -1);
      if (kind !== undefined) {
        this.tools.delete(e.index ?? -1);
        this.cb.onToolEnd(kind);
      }
    }
  }
}

type ClaudeEvent = {
  type: string;
  is_error?: boolean;
  result?: unknown;
  event?: {
    type: string;
    index?: number;
    content_block?: { type: string; name?: string; input?: Record<string, unknown> };
    delta?: { type: string; text?: string };
  };
};

function summarizeTool(
  name: string | undefined,
  input: Record<string, unknown> | undefined,
): { name: string; detail?: string } {
  const display = (name ?? 'Tool')[0].toUpperCase() + (name ?? 'Tool').slice(1);
  if (!input) return { name: display };
  const path = (input.file_path ?? input.path) as string | undefined;
  const cmd = input.command as string | undefined;
  const pattern = input.pattern as string | undefined;
  const url = input.url as string | undefined;
  const query = input.query as string | undefined;
  switch (name) {
    case 'Bash': return { name: 'Bash', detail: cmd ? truncate(cmd, 80) : undefined };
    case 'Edit':
    case 'Write':
    case 'NotebookEdit':
      return { name: display, detail: path };
    case 'Read': return { name: 'Read', detail: path };
    case 'Grep':
    case 'Glob':
      return { name: display, detail: pattern ? truncate(pattern, 80) : undefined };
    case 'WebFetch': return { name: 'WebFetch', detail: url };
    case 'WebSearch': return { name: 'WebSearch', detail: query };
    case 'Task': return { name: 'Task', detail: (input.description ?? input.subagent_type) as string | undefined };
    default: return { name: display };
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
