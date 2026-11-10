import type { CallSource } from '@metro-labs/core/call';
import { APPROVAL_PENDING_MAX, APPROVAL_USE_MS } from '@metro-labs/http/approval-rules';

export type AskAnswer = 'allow' | 'deny' | 'expired';

export type AskState = 'pending' | AskAnswer | 'withdrawn' | 'used';

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
  answeredAt: number;
}

export type Spent = 'unknown' | 'other' | 'late' | 'expired' | 'withdrawn' | 'used';

export type Verdict = { kind: 'ready'; ask: Ask } | { kind: 'waiting' | 'denied' } | { kind: 'spent'; why: Spent };

export const ASKS_KEPT_MAX = 500;

const sameCall = (a: AskedCall, b: AskedCall): boolean =>
  a.tool === b.tool && a.digest === b.digest && a.station === b.station && a.account === b.account && a.agent === b.agent;

const usable = (ask: Ask, now: number): boolean => ask.state === 'allow' && now - ask.answeredAt <= APPROVAL_USE_MS;

const live = (ask: Ask): boolean => ask.state === 'pending' || ask.state === 'allow';

function judged(ask: Ask, now: number): Verdict {
  if (ask.state === 'pending') return { kind: 'waiting' };
  if (ask.state === 'deny') return { kind: 'denied' };
  if (ask.state !== 'allow') return { kind: 'spent', why: ask.state };
  return usable(ask, now) ? { kind: 'ready', ask } : { kind: 'spent', why: 'late' };
}

export class AskLedger {
  private readonly asks = new Map<string, Ask>();

  has(id: string): boolean {
    return this.asks.has(id);
  }

  live(): Ask[] {
    return [...this.asks.values()].filter(live);
  }

  judge(id: string, call: AskedCall, now: number): Verdict {
    const ask = this.asks.get(id);
    if (ask === undefined) return { kind: 'spent', why: 'unknown' };
    return sameCall(ask, call) ? judged(ask, now) : { kind: 'spent', why: 'other' };
  }

  standing(call: AskedCall, now: number): Ask | undefined {
    const same = [...this.asks.values()].filter((ask) => sameCall(ask, call));
    return same.find((ask) => ask.state === 'pending') ?? same.find((ask) => usable(ask, now));
  }

  ask(id: string, call: AskedCall, route: AskRoute): Ask | undefined {
    const waiting = [...this.asks.values()].filter((ask) => ask.state === 'pending').length;
    if (waiting >= APPROVAL_PENDING_MAX || this.asks.has(id)) return undefined;
    for (const [old, ask] of this.asks) {
      if (this.asks.size < ASKS_KEPT_MAX) break;
      if (ask.state !== 'pending') this.asks.delete(old);
    }
    const ask: Ask = { ...call, ...route, id, state: 'pending', answeredAt: 0 };
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

  withdraw(ask: Ask): boolean {
    if (this.asks.get(ask.id) !== ask || !live(ask)) return false;
    ask.state = 'withdrawn';
    return true;
  }

  clear(): void {
    this.asks.clear();
  }
}
