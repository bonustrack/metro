import type { CallSource } from '@metro-labs/core/call';
import { APPROVAL_PENDING_MAX, APPROVAL_TTL_MS, APPROVAL_USE_MS } from '@metro-labs/http/approval-rules';

export type AskState = 'pending' | 'allow' | 'deny' | 'expired' | 'withdrawn' | 'used';

export type AskAnswer = Exclude<AskState, 'pending' | 'used'>;

export interface AskedCall {
  tool: string;
  digest: string;
  station: string;
  account: string;
  agent: string;
}

export interface AskRoute {
  line: string | undefined;
  call: CallSource | undefined;
}

export interface Ask extends AskedCall, AskRoute {
  id: string;
  state: AskState;
  askedAt: number;
  answeredAt: number;
}

export type Spent = 'unknown' | 'other' | 'late' | 'expired' | 'withdrawn' | 'used';

export type Verdict =
  | { kind: 'ready'; ask: Ask }
  | { kind: 'waiting'; ask: Ask }
  | { kind: 'denied'; ask: Ask }
  | { kind: 'spent'; why: Spent };

export const ASKS_KEPT_MAX = 500;
export const ASK_KEEP_MS = 60 * 60_000;
const EXPIRY_GRACE_MS = 5 * 60_000;

const sameCall = (a: AskedCall, b: AskedCall): boolean =>
  a.tool === b.tool && a.digest === b.digest && a.station === b.station && a.account === b.account && a.agent === b.agent;

const usable = (ask: Ask, now: number): boolean => ask.state === 'allow' && now - ask.answeredAt <= APPROVAL_USE_MS;

const live = (ask: Ask): boolean => ask.state === 'pending' || ask.state === 'allow';

function judged(ask: Ask, now: number): Verdict {
  if (ask.state === 'pending') return { kind: 'waiting', ask };
  if (ask.state === 'deny') return { kind: 'denied', ask };
  if (ask.state !== 'allow') return { kind: 'spent', why: ask.state };
  return usable(ask, now) ? { kind: 'ready', ask } : { kind: 'spent', why: 'late' };
}

export class AskLedger {
  private readonly asks = new Map<string, Ask>();

  get size(): number {
    return this.asks.size;
  }

  get pending(): number {
    let waiting = 0;
    for (const ask of this.asks.values()) if (ask.state === 'pending') waiting += 1;
    return waiting;
  }

  get full(): boolean {
    return this.pending >= APPROVAL_PENDING_MAX;
  }

  has(id: string): boolean {
    return this.asks.has(id);
  }

  live(): Ask[] {
    return [...this.asks.values()].filter(live);
  }

  withdraw(ask: Ask, now: number): boolean {
    if (this.asks.get(ask.id) !== ask || !live(ask)) return false;
    ask.state = 'withdrawn';
    ask.answeredAt = now;
    return true;
  }

  judge(id: string, call: AskedCall, now: number): Verdict {
    const ask = this.asks.get(id);
    if (ask === undefined) return { kind: 'spent', why: 'unknown' };
    return sameCall(ask, call) ? judged(ask, now) : { kind: 'spent', why: 'other' };
  }

  standing(call: AskedCall, now: number): Ask | undefined {
    let approved: Ask | undefined;
    for (const ask of this.asks.values()) {
      if (!sameCall(ask, call)) continue;
      if (ask.state === 'pending') return ask;
      if (usable(ask, now)) approved = ask;
    }
    return approved;
  }

  ask(id: string, call: AskedCall, route: AskRoute, now: number): Ask | undefined {
    if (this.full || this.asks.has(id)) return undefined;
    this.makeRoom();
    const ask: Ask = { ...call, ...route, id, state: 'pending', askedAt: now, answeredAt: 0 };
    this.asks.set(id, ask);
    return ask;
  }

  settle(id: string, answer: AskAnswer, now: number): Ask | undefined {
    const ask = this.asks.get(id);
    if (ask?.state !== 'pending') return undefined;
    ask.state = answer;
    ask.answeredAt = now;
    return ask;
  }

  use(ask: Ask, now: number): boolean {
    if (this.asks.get(ask.id) !== ask || !usable(ask, now)) return false;
    ask.state = 'used';
    return true;
  }

  sweep(now: number): void {
    for (const [id, ask] of this.asks) {
      if (ask.state !== 'pending') {
        if (now - ask.answeredAt >= ASK_KEEP_MS) this.asks.delete(id);
      } else if (now - ask.askedAt >= APPROVAL_TTL_MS + EXPIRY_GRACE_MS) this.settle(id, 'expired', now);
    }
  }

  clear(): void {
    this.asks.clear();
  }

  private makeRoom(): void {
    for (const [id, ask] of this.asks) {
      if (this.asks.size < ASKS_KEPT_MAX) return;
      if (ask.state !== 'pending') this.asks.delete(id);
    }
  }
}
