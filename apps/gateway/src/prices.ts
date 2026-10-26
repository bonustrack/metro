import { errMsg, log } from '@metro-labs/core/log';
import type { FetchLike } from '@metro-labs/core/stations/oauth';
import { routewayModels } from '@metro-labs/connectors/model-lists';
import type { AttemptCall } from '@metro-labs/inference/attempts';
import type { Connection } from '@metro-labs/inference/model-config';

interface Price {
  input: number;
  output: number;
  read: number;
}

const WRITE_5M = 1.25;
const WRITE_1H = 2;
const MICROS_PER_DOLLAR = 1_000_000;
const PER_MILLION = 1_000_000;
const HAIKU_LONG_PROMPT = 100_000;
const HAIKU_LONG_FACTOR = 5;
const ROUTEWAY_TTL_MS = 60 * 60_000;

const CLAUDE_PRICES: Record<string, Price> = {
  'claude-fable-5-1': { input: 10, output: 50, read: 0.25 },
  'claude-mythos-5-1': { input: 10, output: 50, read: 0.25 },
  'claude-fable-5': { input: 10, output: 50, read: 1 },
  'claude-opus-5-5': { input: 4, output: 20, read: 0.2 },
  'claude-opus-5': { input: 5, output: 25, read: 0.5 },
  'claude-opus-4-8': { input: 5, output: 25, read: 0.5 },
  'claude-opus-4-7': { input: 5, output: 25, read: 0.5 },
  'claude-opus-4-6': { input: 5, output: 25, read: 0.5 },
  'claude-sonnet-5-5': { input: 2, output: 10, read: 0.2 },
  'claude-sonnet-5': { input: 2, output: 10, read: 0.2 },
  'claude-sonnet-4-6': { input: 3, output: 15, read: 0.3 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, read: 0.01 },
  'claude-haiku-4-5': { input: 1, output: 5, read: 0.1 },
};

const BY_LENGTH = Object.keys(CLAUDE_PRICES).sort((a, b) => b.length - a.length);

export function claudePrice(model: string): Price | null {
  const bare = model.trim().toLowerCase();
  const id = BY_LENGTH.find((known) => bare === known || bare.startsWith(`${known}-`));
  return id === undefined ? null : (CLAUDE_PRICES[id] ?? null);
}

const prompted = (call: AttemptCall): number => call.tokens.input + call.tokens.cacheRead + call.tokens.cacheWrite5m + call.tokens.cacheWrite1h;

function claudeDollars(call: AttemptCall): number | null {
  const base = claudePrice(call.model);
  if (base === null) return null;
  const long = call.model.startsWith('claude-haiku-5-5') && prompted(call) > HAIKU_LONG_PROMPT ? HAIKU_LONG_FACTOR : 1;
  const { input, output, read } = { input: base.input * long, output: base.output * long, read: base.read * long };
  const { tokens } = call;
  return (tokens.input * input + tokens.output * output + tokens.cacheRead * read + tokens.cacheWrite5m * input * WRITE_5M + tokens.cacheWrite1h * input * WRITE_1H) / PER_MILLION;
}

interface TokenPrice {
  prompt: number | null;
  completion: number | null;
}

export class RoutewayPrices {
  private prices = new Map<string, TokenPrice>();
  private loadedAt = Number.NEGATIVE_INFINITY;
  private loading: Promise<void> | null = null;

  constructor(
    private readonly fetchImpl: FetchLike,
    private readonly now: () => number = Date.now,
  ) {}

  of(model: string): TokenPrice | null {
    if (this.now() - this.loadedAt >= ROUTEWAY_TTL_MS) this.refresh();
    return this.prices.get(model) ?? null;
  }

  refresh(): void {
    if (this.loading !== null) return;
    this.loading = routewayModels(this.fetchImpl).then(
      (list) => {
        this.prices = new Map(list.flatMap((model) => (model.price === undefined ? [] : [[model.id, model.price] as const])));
        this.loadedAt = this.now();
        this.loading = null;
      },
      (err: unknown) => {
        log.warn({ err: errMsg(err) }, 'gateway: the Routeway price list could not be read, so Routeway calls have no cost for now');
        this.loadedAt = this.now();
        this.loading = null;
      },
    );
  }
}

function routewayDollars(call: AttemptCall, prices: RoutewayPrices): number | null {
  const price = prices.of(call.model);
  if (price === null || price.prompt === null || price.completion === null) return null;
  return prompted(call) * price.prompt + call.tokens.output * price.completion;
}

function dollars(call: AttemptCall, conn: Connection | undefined, routeway: RoutewayPrices): number | null {
  if (call.provider === 'openrouter') return call.providerCost;
  if (call.provider === 'routeway') return routewayDollars(call, routeway);
  if (call.provider === 'anthropic' && conn !== undefined && conn.apiKey !== '') return claudeDollars(call);
  return null;
}

export function costMicros(call: AttemptCall, conn: Connection | undefined, routeway: RoutewayPrices): number | null {
  const value = dollars(call, conn, routeway);
  return value === null || !Number.isFinite(value) || value < 0 ? null : Math.round(value * MICROS_PER_DOLLAR);
}
