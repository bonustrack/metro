/** Worker supervisor: spawn `~/.metro/workers/*.{ts,js,mjs}` under `bun run`, multiplex their */
/** stdout (events + call-responses), route outbound calls to their stdin. Pure transport. */

import { mkdirSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, parse as parsePath } from 'node:path';
import { errMsg, log } from './log.js';

const RESTART_BACKOFFS_MS = [1_000, 5_000, 30_000] as const;
const MAX_CONSECUTIVE_FAILS = 5;
const CALL_TIMEOUT_MS = 60_000;
const STDOUT_LINE_MAX = 4 * 1024 * 1024; // 4 MiB safeguard per line

export const WORKERS_DIR = process.env.METRO_WORKERS_DIR ?? join(homedir(), '.metro', 'workers');

export type WorkerEvent = Record<string, unknown>;
export type WorkerCallResponse = { result?: unknown; error?: string };

type Pending = {
  resolve: (r: WorkerCallResponse) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type WorkerState = {
  name: string;
  path: string;
  proc: ReturnType<typeof Bun.spawn> | null;
  pending: Map<string, Pending>;
  buf: string;
  failCount: number;
  restartTimer: ReturnType<typeof setTimeout> | null;
  startedAt: string | null;
  stopped: boolean;
};

export type WorkerInfo = {
  name: string;
  path: string;
  running: boolean;
  pid: number | null;
  startedAt: string | null;
  failCount: number;
};

export class WorkerSupervisor {
  private workers = new Map<string, WorkerState>();
  private onEvent: ((event: WorkerEvent, worker: string) => void) | null = null;
  private nextCallId = 1;

  constructor(private dir: string = WORKERS_DIR) {}

  onWorkerEvent(handler: (event: WorkerEvent, worker: string) => void): void {
    this.onEvent = handler;
  }

  /** Discover workers under `dir` and spawn one subprocess per file. Creates the dir if missing. */
  start(): void {
    mkdirSync(this.dir, { recursive: true });
    const files = readdirSync(this.dir).filter(isWorkerFile)
      .map(f => ({ name: parsePath(f).name, path: join(this.dir, f) }))
      .filter(w => { try { return statSync(w.path).isFile(); } catch { return false; } });
    for (const w of files) this.startWorker(w.name, w.path);
    log.info({ dir: this.dir, count: this.workers.size }, 'worker supervisor: started');
  }

  /** Shut everything down (graceful: send SIGTERM, then SIGKILL after grace period). */
  async stop(): Promise<void> {
    const tasks: Promise<unknown>[] = [];
    for (const w of this.workers.values()) {
      w.stopped = true;
      if (w.restartTimer) { clearTimeout(w.restartTimer); w.restartTimer = null; }
      for (const p of w.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error('worker shutting down'));
      }
      w.pending.clear();
      if (w.proc && w.proc.exitCode === null) {
        try { w.proc.kill('SIGTERM'); } catch { /* ignore */ }
        const grace = setTimeout(() => { try { w.proc?.kill('SIGKILL'); } catch { /* ignore */ } }, 2_000);
        tasks.push(w.proc.exited.finally(() => clearTimeout(grace)));
      }
    }
    await Promise.all(tasks);
  }

  list(): WorkerInfo[] {
    return [...this.workers.values()].map(w => ({
      name: w.name, path: w.path,
      running: !!(w.proc && w.proc.exitCode === null),
      pid: w.proc?.pid ?? null,
      startedAt: w.startedAt,
      failCount: w.failCount,
    }));
  }

  /** Send a call to a named worker and await the matching response. */
  async call(name: string, action: string, args: unknown): Promise<WorkerCallResponse> {
    const w = this.workers.get(name);
    if (!w) throw new Error(`no worker named '${name}' (have: ${[...this.workers.keys()].join(', ') || '(none)'})`);
    if (!w.proc || w.proc.exitCode !== null) throw new Error(`worker '${name}' is not running`);
    const id = `req_${this.nextCallId++}_${Math.random().toString(36).slice(2, 8)}`;
    const payload = JSON.stringify({ op: 'call', id, action, args }) + '\n';
    return new Promise<WorkerCallResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        w.pending.delete(id);
        reject(new Error(`worker '${name}' call '${action}' timed out after ${CALL_TIMEOUT_MS}ms`));
      }, CALL_TIMEOUT_MS);
      w.pending.set(id, { resolve, reject, timer });
      try {
        const stdin = w.proc!.stdin;
        if (!stdin || typeof stdin === 'number') throw new Error('stdin not piped');
        stdin.write(payload);
        stdin.flush();
      } catch (err) {
        clearTimeout(timer);
        w.pending.delete(id);
        reject(new Error(`worker '${name}' stdin write failed: ${errMsg(err)}`));
      }
    });
  }

  private startWorker(name: string, path: string): void {
    if (this.workers.has(name)) {
      log.warn({ name }, 'worker supervisor: duplicate name, skipping');
      return;
    }
    const state: WorkerState = {
      name, path, proc: null, pending: new Map(), buf: '',
      failCount: 0, restartTimer: null, startedAt: null, stopped: false,
    };
    this.workers.set(name, state);
    this.spawn(state);
  }

  private spawn(state: WorkerState): void {
    if (state.stopped) return;
    try {
      const proc = Bun.spawn(['bun', 'run', state.path], {
        stdin: 'pipe', stdout: 'pipe', stderr: 'inherit',
        env: { ...process.env, METRO_WORKER_NAME: state.name },
      });
      state.proc = proc;
      state.startedAt = new Date().toISOString();
      state.buf = '';
      log.info({ name: state.name, pid: proc.pid }, 'worker: spawned');
      void this.pumpStdout(state);
      void proc.exited.then(code => this.onExit(state, code ?? 0));
    } catch (err) {
      log.warn({ name: state.name, err: errMsg(err) }, 'worker: spawn failed');
      this.scheduleRestart(state);
    }
  }

  private async pumpStdout(state: WorkerState): Promise<void> {
    const proc = state.proc;
    if (!proc || !proc.stdout) return;
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
    const dec = new TextDecoder();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        state.buf += dec.decode(value, { stream: true });
        if (state.buf.length > STDOUT_LINE_MAX && !state.buf.includes('\n')) {
          log.warn({ name: state.name, bytes: state.buf.length }, 'worker: dropping oversized stdout line');
          state.buf = '';
        }
        let nl;
        while ((nl = state.buf.indexOf('\n')) !== -1) {
          const line = state.buf.slice(0, nl).trim();
          state.buf = state.buf.slice(nl + 1);
          if (!line) continue;
          this.handleLine(state, line);
        }
      }
    } catch (err) {
      log.debug({ name: state.name, err: errMsg(err) }, 'worker: stdout pump ended');
    }
  }

  private handleLine(state: WorkerState, line: string): void {
    let msg: { op?: string; id?: string; result?: unknown; error?: string } & Record<string, unknown>;
    try { msg = JSON.parse(line); }
    catch (err) {
      log.warn({ name: state.name, err: errMsg(err), line: line.slice(0, 200) }, 'worker: bad JSON');
      return;
    }
    if (msg.op === 'response') {
      const id = msg.id;
      if (typeof id !== 'string') return;
      const pending = state.pending.get(id);
      if (!pending) {
        log.debug({ name: state.name, id }, 'worker: response for unknown id (timed out?)');
        return;
      }
      state.pending.delete(id);
      clearTimeout(pending.timer);
      pending.resolve({ result: msg.result, error: msg.error });
      return;
    }
    if (msg.op === 'log') {
      log.info({ name: state.name, msg: msg.text }, 'worker log');
      return;
    }
    /** Anything without an `op` (or with `op:"event"`) is an inbound event. */
    this.onEvent?.(msg as WorkerEvent, state.name);
  }

  private onExit(state: WorkerState, code: number): void {
    log.warn({ name: state.name, code }, 'worker: exited');
    state.proc = null;
    state.startedAt = null;
    /** fail pending calls */
    for (const p of state.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error(`worker '${state.name}' exited (code=${code}) before responding`));
    }
    state.pending.clear();
    if (state.stopped) return;
    state.failCount++;
    if (state.failCount >= MAX_CONSECUTIVE_FAILS) {
      log.error({ name: state.name, fails: state.failCount },
        'worker: too many consecutive failures, giving up (restart metro to retry)');
      return;
    }
    this.scheduleRestart(state);
  }

  private scheduleRestart(state: WorkerState): void {
    if (state.stopped) return;
    const idx = Math.min(state.failCount, RESTART_BACKOFFS_MS.length - 1);
    const delay = RESTART_BACKOFFS_MS[idx];
    log.info({ name: state.name, delay, attempt: state.failCount }, 'worker: restart scheduled');
    state.restartTimer = setTimeout(() => {
      state.restartTimer = null;
      /** Any subprocess that survives 30s resets its consecutive-fail counter. */
      this.spawn(state);
      setTimeout(() => { if (state.proc && state.proc.exitCode === null) state.failCount = 0; }, 30_000);
    }, delay);
  }
}

function isWorkerFile(name: string): boolean {
  return /\.(ts|js|mjs)$/.test(name) && !name.startsWith('_') && !name.startsWith('.');
}
