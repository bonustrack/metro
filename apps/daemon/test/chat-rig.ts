import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { ChatReply } from '@metro-labs/core/chat';
import { ChatSessions } from '../src/chat/sessions.ts';
import { ChatTurns, type ChatPids, type ChatRunnerDeps, type ChatSignal } from '../src/chat/turns.ts';

export class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly sent: Record<string, unknown>[] = [];
  pid: number | undefined = 4242;

  constructor() {
    super();
    this.stdin.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString().split('\n').filter(Boolean)) this.sent.push(JSON.parse(line) as Record<string, unknown>);
    });
  }

  say(value: unknown): void {
    this.stdout.write(`${JSON.stringify(value)}\n`);
  }

  kill(): boolean {
    return true;
  }

  exit(code: number | null): void {
    setTimeout(() => {
      this.stdout.end();
      this.emit('exit', code);
    }, 5);
  }
}

export const tick = (ms = 20): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface Rig {
  turns: ChatTurns;
  children: FakeChild[];
  posted: { chat: string; message: string; reply: ChatReply }[];
  signals: { signal: ChatSignal; pids: ChatPids | null }[];
  dir: string;
  fail: { posts: number; refused: boolean };
  clock: { at: number };
}

export function rig(over: Partial<ChatRunnerDeps> = {}): Rig {
  const dir = mkdtempSync(join(tmpdir(), 'metro-chat-'));
  const children: FakeChild[] = [];
  const posted: Rig['posted'] = [];
  const signals: Rig['signals'] = [];
  const fail = { posts: 0, refused: false };
  const clock = { at: Date.now() };
  const turns = new ChatTurns({
    spawn: () => {
      const child = new FakeChild();
      children.push(child);
      return child as unknown as ChildProcessWithoutNullStreams;
    },
    signal: (_child, pids, signal) => {
      signals.push({ signal, pids });
    },
    sessions: new ChatSessions(dir),
    post: (chat, message, reply) => {
      if (fail.posts > 0) {
        fail.posts -= 1;
        return Promise.reject(new Error('metro.box is down'));
      }
      posted.push({ chat, message, reply });
      return Promise.resolve();
    },
    refused: () => fail.refused,
    now: () => clock.at,
    pause: (ms) => {
      clock.at += ms;
      return Promise.resolve();
    },
    graceMs: 30,
    ...over,
  });
  return { turns, children, posted, signals, dir, fail, clock };
}

export function only(children: FakeChild[], at = 0): FakeChild {
  const child = children[at];
  if (child === undefined) throw new Error('no child');
  return child;
}
