import { applyTurnEvent, type ChatPart, type ChatReply, type ReplyState, type TurnEvent } from '@metro-labs/core/chat';

const EVENTS_KEPT = 4_000;
const GATHER_MS = 40;

export type Delivery = 'pending' | 'saved' | 'failed';

export interface TurnView {
  seq: number;
  delivery: Delivery;
  events: TurnEvent[];
  parts: ChatPart[] | null;
  done: boolean;
  state: ReplyState | null;
  error: string | null;
}

export class Turn {
  private parts: ChatPart[] = [];
  private events: TurnEvent[] = [];
  private base = 0;
  private result: { state: ReplyState; error: string | null } | null = null;
  private readonly waiters = new Set<() => void>();
  endedAt: number | null = null;
  settledAt: number | null = null;
  delivery: Delivery = 'pending';

  constructor(
    readonly id: string,
    readonly chat: string,
    readonly startedAt: number,
  ) {}

  get seq(): number {
    return this.base + this.events.length;
  }

  get done(): boolean {
    return this.result !== null;
  }

  apply(event: TurnEvent, now: number): void {
    if (this.result !== null) return;
    if (event.t === 'done') {
      this.finish(event.state, event.error, now);
      return;
    }
    this.parts = applyTurnEvent(this.parts, event);
    this.events.push(event);
    if (this.events.length > EVENTS_KEPT) {
      const dropped = this.events.length - EVENTS_KEPT;
      this.events = this.events.slice(dropped);
      this.base += dropped;
    }
    this.wake();
  }

  finish(state: ReplyState, error: string | null, now: number): void {
    if (this.result !== null) return;
    this.result = { state, error };
    this.endedAt = now;
    this.events.push({ t: 'done', state, error });
    this.wake();
  }

  delivered(saved: boolean, now: number): void {
    this.delivery = saved ? 'saved' : 'failed';
    this.settledAt = now;
    this.wake();
  }

  redelivering(): void {
    this.delivery = 'pending';
    this.settledAt = null;
    this.wake();
  }

  reply(): ChatReply {
    return { parts: this.parts.map(settledPart), state: this.result?.state ?? 'error', error: this.result?.error ?? null, ms: Math.max(0, (this.endedAt ?? this.startedAt) - this.startedAt) };
  }

  view(after: number): TurnView {
    const snapshot = after < this.base || after > this.seq;
    return {
      seq: this.seq,
      delivery: this.delivery,
      events: snapshot ? [] : this.events.slice(after - this.base),
      parts: snapshot ? [...this.parts] : null,
      done: this.result !== null,
      state: this.result?.state ?? null,
      error: this.result?.error ?? null,
    };
  }

  async changed(after: number, waitMs: number): Promise<void> {
    if (this.seq !== after || (this.result !== null && this.delivery !== 'pending')) return;
    await new Promise<void>((resolve) => {
      let gather: ReturnType<typeof setTimeout> | undefined;
      const finish = (): void => {
        clearTimeout(timer);
        clearTimeout(gather);
        this.waiters.delete(wake);
        resolve();
      };
      const wake = (): void => {
        clearTimeout(timer);
        gather = setTimeout(finish, GATHER_MS);
      };
      const timer = setTimeout(finish, waitMs);
      this.waiters.add(wake);
    });
  }

  private wake(): void {
    const waiting = [...this.waiters];
    this.waiters.clear();
    for (const wake of waiting) wake();
  }
}

function settledPart(part: ChatPart): ChatPart {
  return part.type === 'approval' && part.state === 'waiting' ? { ...part, state: 'denied' } : part;
}
