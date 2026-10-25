import { AsyncLocalStorage } from 'node:async_hooks';
import type { OutgoingHttpHeader, OutgoingHttpHeaders, ServerResponse } from 'node:http';
import type { RequestKind } from './effort.js';
import type { Route } from './model-config.js';

export type AttemptOutcome = 'ok' | 'rate_limited' | 'refused' | 'provider_error' | 'cancelled';

export type AttemptKind = 'main' | 'subagent' | 'compaction' | 'chore';

export interface AttemptTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

export interface AttemptCall {
  connection: string;
  provider: string;
  model: string;
  lane: 'main' | 'workers';
  kind: AttemptKind;
  attempt: number;
  status: number;
  outcome: AttemptOutcome;
  tokens: AttemptTokens;
  providerCost: number | null;
  ms: number;
  firstTokenMs: number | null;
  at: number;
}

export type OnCall = (call: AttemptCall) => void;

const KINDS: Record<RequestKind, AttemptKind> = { main: 'main', subagent: 'subagent', compact: 'compaction', other: 'chore' };

const NO_TOKENS: AttemptTokens = { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 };

export class Attempt {
  private readonly started = Date.now();
  private firstAt: number | null = null;
  private status: number | null = null;
  private failedMidStream = false;
  private tokens: AttemptTokens = NO_TOKENS;
  private cost: number | null = null;

  constructor(
    private readonly route: Route,
    private readonly lane: 'main' | 'helpers',
    private readonly kind: RequestKind,
    private readonly index: number,
  ) {}

  firstByte(): void {
    this.firstAt ??= Date.now();
  }

  answered(status: number): void {
    this.status ??= status;
  }

  failed(): void {
    this.failedMidStream = true;
  }

  counted(tokens: AttemptTokens, cost: number | null): void {
    this.tokens = tokens;
    this.cost = cost;
  }

  call(fallbackStatus: number, cancelled: boolean): AttemptCall {
    const status = this.status ?? fallbackStatus;
    const ended = Date.now();
    return {
      connection: this.route.connection.id,
      provider: this.route.connection.provider,
      model: this.route.model,
      lane: this.lane === 'helpers' ? 'workers' : 'main',
      kind: KINDS[this.kind],
      attempt: this.index,
      status,
      outcome: cancelled ? 'cancelled' : outcomeOf(status, this.failedMidStream),
      tokens: this.tokens,
      providerCost: this.cost,
      ms: ended - this.started,
      firstTokenMs: this.firstAt === null ? null : this.firstAt - this.started,
      at: ended,
    };
  }
}

function outcomeOf(status: number, failedMidStream: boolean): AttemptOutcome {
  if (status === 402 || status === 429) return 'rate_limited';
  if (status >= 500) return 'provider_error';
  if (status >= 400) return 'refused';
  return failedMidStream ? 'provider_error' : 'ok';
}

const current = new AsyncLocalStorage<Attempt>();

export const currentAttempt = (): Attempt | undefined => current.getStore();

export const inAttempt = <T>(attempt: Attempt, run: () => Promise<T>): Promise<T> => current.run(attempt, run);

export function tracked(res: ServerResponse, attempt: Attempt): ServerResponse {
  const proxy: ServerResponse = new Proxy(res, {
    get(target, prop) {
      if (prop === 'writeHead')
        return (status: number, headers?: OutgoingHttpHeaders | OutgoingHttpHeader[]): ServerResponse => {
          attempt.answered(status);
          target.writeHead(status, headers);
          return proxy;
        };
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
  return proxy;
}
