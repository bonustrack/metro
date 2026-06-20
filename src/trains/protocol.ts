import { readdirSync, statSync } from 'node:fs';
import { join, parse as parsePath } from 'node:path';
import { errMsg, log } from '../log.js';
import { coerceErrorInfo, type TrainErrorInfo } from '../train-error.js';
import type { WireEvent } from '../history-types.js';

export {
  TrainError,
  serializeTrainError,
  type TrainErrorInfo,
} from '../train-error.js';

export const CALL_TIMEOUT_MS = 60_000;

export interface Pending {
  resolve: (r: TrainCallResponse) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}
export interface CallTarget {
  name: string;
  pending: Map<string, Pending>;
  proc: ({ stdin?: unknown } & Record<string, unknown>) | null;
}

export const STDOUT_LINE_MAX = 4 * 1024 * 1024;

export type TrainEvent = {
  station?: string;
  line?: string;
  line_name?: string;
  from?: string;
  from_name?: string;
  to?: string;
  message_id?: string;
  reply_to?: string;
  is_private?: boolean;
  text?: string;
  emoji?: string;
  payload?: unknown;
  ts?: string;
  id?: string;
  event?: WireEvent;
} & Record<string, unknown>;

export interface TrainCallResponse {
  result?: unknown;
  error?: string;
  errorInfo?: TrainErrorInfo;
}

export type TrainMessage =
  | {
      op: 'response';
      id: string;
      result?: unknown;
      error?: string;
      errorInfo?: TrainErrorInfo;
    }
  | { op: 'log'; text?: string }
  | { op: 'event'; event: TrainEvent }
  | { op: 'ignore' };

export function parseTrainLine(
  name: string,
  line: string,
): TrainMessage | null {
  let msg: {
    op?: string;
    id?: string;
    result?: unknown;
    error?: string;
    errorInfo?: unknown;
    text?: string;
  } & Record<string, unknown>;
  try {
    msg = JSON.parse(line) as typeof msg;
  } catch (err) {
    log.warn(
      { name, err: errMsg(err), line: line.slice(0, 200) },
      'train: bad JSON',
    );
    return null;
  }
  if (msg.op === 'response') {
    if (typeof msg.id !== 'string') return { op: 'ignore' };
    return {
      op: 'response',
      id: msg.id,
      result: msg.result,
      error: msg.error,
      errorInfo: coerceErrorInfo(msg.errorInfo),
    };
  }
  if (msg.op === 'log') return { op: 'log', text: msg.text };
  if (typeof msg.line !== 'string') {
    log.warn(
      { name, line: line.slice(0, 200) },
      'train: event missing `line` (string) — dropped',
    );
    return { op: 'ignore' };
  }
  return { op: 'event', event: msg };
}

export function drainLines(
  name: string,
  buf: string,
  onLine: (line: string) => void,
): string {
  if (buf.length > STDOUT_LINE_MAX && !buf.includes('\n')) {
    log.warn(
      { name, bytes: buf.length },
      'train: dropping oversized stdout line',
    );
    return '';
  }
  let nl;
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    onLine(line);
  }
  return buf;
}

export function encodeCall(id: string, action: string, args: unknown): string {
  return JSON.stringify({ op: 'call', id, action, args }) + '\n';
}

function isTrainFile(name: string): boolean {
  return (
    /\.(ts|js|mjs)$/.test(name) &&
    !name.startsWith('_') &&
    !name.startsWith('.')
  );
}

export function listTrainFiles(dir: string): { name: string; path: string }[] {
  return readdirSync(dir)
    .filter(isTrainFile)
    .map((f) => ({ name: parsePath(f).name, path: join(dir, f) }))
    .filter((t) => {
      try {
        return statSync(t.path).isFile();
      } catch {
        return false;
      }
    });
}

export function mintCallId(seq: number): string {
  return `req_${seq}_${Math.random().toString(36).slice(2, 8)}`;
}

export function failAllPending(
  pending: Map<string, Pending>,
  reason: string,
): void {
  for (const p of pending.values()) {
    clearTimeout(p.timer);
    p.reject(new Error(reason));
  }
  pending.clear();
}

export function sendCall(
  t: CallTarget,
  id: string,
  action: string,
  args: unknown,
): Promise<TrainCallResponse> {
  return new Promise<TrainCallResponse>((resolve, reject) => {
    const timer = setTimeout(() => {
      t.pending.delete(id);
      reject(
        new Error(
          `train '${t.name}' call '${action}' timed out after ${CALL_TIMEOUT_MS}ms`,
        ),
      );
    }, CALL_TIMEOUT_MS);
    t.pending.set(id, { resolve, reject, timer });
    try {
      const stdin = (
        t.proc as {
          stdin?: { write: (s: string) => void; flush: () => void };
        } | null
      )?.stdin;
      if (!stdin || typeof stdin === 'number')
        throw new Error('stdin not piped');
      stdin.write(encodeCall(id, action, args));
      stdin.flush();
    } catch (err) {
      clearTimeout(timer);
      t.pending.delete(id);
      reject(new Error(`train '${t.name}' stdin write failed: ${errMsg(err)}`));
    }
  });
}
