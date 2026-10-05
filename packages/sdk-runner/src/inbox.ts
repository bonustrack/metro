import { randomUUID } from 'node:crypto';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

export type Uuid = ReturnType<typeof randomUUID>;
export type InputKind = 'chat' | 'call' | 'note';
export type Priority = 'now' | 'next' | 'later';

export interface Unanswered {
  text: string;
  at: number;
  uuid?: Uuid;
  state?: 'queued' | 'started';
}

const KINDS_MAX = 2_000;
const LEDGER_MAX = 100;
const LEDGER_AGE_MS = 6 * 60 * 60_000;

export class Inbox implements AsyncIterable<SDKUserMessage> {
  private readonly queue: SDKUserMessage[] = [];
  private readonly kinds = new Map<string, InputKind>();
  private readonly ledger = new Map<string, Unanswered>();
  private wake: (() => void) | null = null;
  private closed = false;
  private restoring = false;

  constructor(private readonly changed: (unanswered: Unanswered[]) => void = () => undefined) {}

  push(kind: InputKind, text: string, priority?: Priority, uuid: Uuid = randomUUID(), at = Date.now()): Uuid {
    this.mark(uuid, kind);
    if (kind === 'chat') this.remember(uuid, text, at);
    this.queue.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      uuid,
      origin: { kind: 'channel', server: 'metro' },
      ...(priority === undefined ? {} : { priority }),
    });
    this.wake?.();
    return uuid;
  }

  mark(uuid: string, kind: InputKind): void {
    this.kinds.set(uuid, kind);
    if (this.kinds.size <= KINDS_MAX) return;
    const oldest = this.kinds.keys().next().value;
    if (oldest !== undefined) this.kinds.delete(oldest);
  }

  kindOf(uuid: string): InputKind | undefined {
    return this.kinds.get(uuid);
  }

  started(uuids: readonly string[]): void {
    let changed = false;
    for (const uuid of uuids) {
      const entry = this.ledger.get(uuid);
      if (entry === undefined || entry.state === 'started') continue;
      this.ledger.set(uuid, { ...entry, state: 'started' });
      changed = true;
    }
    if (changed) this.changed(this.unanswered());
  }

  finished(uuids = this.startedUuids()): void {
    let changed = false;
    for (const uuid of uuids) changed = this.ledger.delete(uuid) || changed;
    if (changed) this.changed(this.unanswered());
  }

  startedUuids(): string[] {
    return [...this.ledger].filter(([, entry]) => entry.state === 'started').map(([uuid]) => uuid);
  }

  unanswered(now = Date.now()): Unanswered[] {
    return [...this.ledger.values()].filter((entry) => entry.state === 'started' || now - entry.at < LEDGER_AGE_MS);
  }

  close(): void {
    this.closed = true;
    this.wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    while (!this.closed) {
      const next = this.queue.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
      this.wake = null;
    }
  }

  again(left: readonly Unanswered[]): void {
    if (left.length === 0) return;
    this.restoring = true;
    try {
      for (const entry of left) this.push('chat', entry.text, undefined, entry.uuid ?? randomUUID(), entry.at);
    } finally {
      this.restoring = false;
    }
    this.changed(this.unanswered());
  }

  private remember(uuid: Uuid, text: string, at: number): void {
    this.ledger.set(uuid, { text, at, uuid, state: 'queued' });
    while (this.ledger.size > LEDGER_MAX) {
      const oldest = [...this.ledger].find(([, entry]) => entry.state !== 'started')?.[0];
      if (oldest === undefined) break;
      this.ledger.delete(oldest);
    }
    if (!this.restoring) this.changed(this.unanswered());
  }
}
