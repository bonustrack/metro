import { randomUUID } from 'node:crypto';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { RunnerInput } from '@metro-labs/core/runner-activity';
import { InputQueue } from './input-queue.js';
import { InputTiming, type InputWatch } from './input-timing.js';

export type Uuid = ReturnType<typeof randomUUID>;
export type InputKind = RunnerInput['kind'];
export type Priority = 'now' | 'next' | 'later';

export interface Unanswered {
  text: string;
  at: number;
  uuid?: Uuid;
  state?: 'queued' | 'started';
}

interface InboxHooks {
  ready?(): boolean;
  dispatch?(message: SDKUserMessage): void;
  queue?(count: number, oldest: number | null): void;
  input?: InputWatch;
}

const KINDS_MAX = 2_000;
const LEDGER_MAX = 100;
const LEDGER_AGE_MS = 6 * 60 * 60_000;

export class Inbox implements AsyncIterable<SDKUserMessage> {
  private readonly queue = new InputQueue();
  private readonly kinds = new Map<string, InputKind>();
  private readonly ledger = new Map<string, Unanswered>();
  private readonly dispatched = new Set<string>();
  private readonly timing: InputTiming;
  private wake: (() => void) | null = null;
  private closed = false;
  private restoring = false;

  constructor(private readonly changed: (unanswered: Unanswered[]) => void = () => undefined, private readonly hooks: InboxHooks = {}) {
    this.timing = new InputTiming(hooks.input ?? (() => undefined));
  }

  get pending(): number { return this.queue.size; }

  accepts(kind: InputKind, text: string): boolean { return !this.closed && this.queue.accepts(kind, text); }

  activeUuids(): Set<string> { return new Set([...this.dispatched, ...this.startedUuids()]); }

  compact(): Uuid {
    const uuid = this.push('note', '/compact');
    this.queue.prefer(uuid);
    return uuid;
  }

  push(kind: InputKind, text: string, _priority?: Priority, uuid: Uuid = randomUUID(), at = Date.now()): Uuid {
    return this.enqueue(kind, text, uuid, at, { origin: { kind: 'channel', server: 'metro' } });
  }

  automation(text: string, uuid: Uuid, at: number): Uuid {
    return this.enqueue('note', text, uuid, at, { origin: { kind: 'task-notification', subkind: 'scheduled-trigger' }, client_composed: true });
  }

  private enqueue(kind: InputKind, text: string, uuid: Uuid, at: number, provenance: Pick<SDKUserMessage, 'origin' | 'client_composed'>): Uuid {
    if (this.closed) throw new Error('The SDK input queue is closed.');
    this.queue.check(kind, text);
    if (kind === 'chat') this.remember(uuid, text, at);
    this.mark(uuid, kind);
    this.queue.push(kind, {
      type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null,
      uuid, ...provenance,
    }, text, at);
    this.timing.accept(uuid, kind, at);
    this.notify();
    return uuid;
  }

  mark(uuid: string, kind: InputKind): void {
    this.kinds.set(uuid, kind);
    if (this.kinds.size <= KINDS_MAX) return;
    const oldest = this.kinds.keys().next().value;
    if (oldest !== undefined) this.kinds.delete(oldest);
  }

  kindOf(uuid: string): InputKind | undefined { return this.kinds.get(uuid); }

  started(uuids: readonly string[]): void {
    let changed = false;
    for (const uuid of uuids) {
      const entry = this.ledger.get(uuid);
      if (entry === undefined || entry.state === 'started') continue;
      this.ledger.set(uuid, { ...entry, state: 'started' });
      changed = true;
    }
    if (changed) this.changed(this.unanswered());
    this.timing.consume(uuids);
  }

  output(): void { this.timing.output(); }
  boundary(): void { this.timing.boundary(); }

  finished(uuids = this.startedUuids()): void {
    let changed = false;
    for (const uuid of uuids) {
      this.dispatched.delete(uuid);
      changed = this.ledger.delete(uuid) || changed;
    }
    if (changed) this.changed(this.unanswered());
    this.timing.finish(uuids);
  }

  cancel(uuids: readonly string[]): void {
    const ephemeral = uuids.filter((uuid) => this.kindOf(uuid) !== 'chat');
    const removed = this.queue.cancel(new Set(ephemeral));
    this.timing.finish(removed, true);
    this.notify();
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

  notify(): void {
    this.hooks.queue?.(this.queue.size, this.queue.oldest);
    this.wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    while (!this.closed) {
      const next = (this.hooks.ready?.() ?? true) ? this.queue.take() : undefined;
      if (next !== undefined) {
        if (next.uuid !== undefined && this.ledger.has(next.uuid)) this.dispatched.add(next.uuid);
        this.hooks.dispatch?.(next);
        if (next.uuid !== undefined) this.timing.dispatch(next.uuid);
        this.notify();
        yield next;
        continue;
      }
      await new Promise<void>((resolve) => { this.wake = resolve; });
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
    if (!this.ledger.has(uuid) && this.ledger.size >= LEDGER_MAX) throw new Error('The SDK input queue is full. Wait for queued work to finish before retrying.');
    this.ledger.set(uuid, { text, at, uuid, state: 'queued' });
    if (!this.restoring) this.changed(this.unanswered());
  }
}
