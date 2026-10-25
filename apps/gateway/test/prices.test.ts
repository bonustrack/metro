import { describe, expect, test } from 'bun:test';
import type { AttemptCall } from '@metro-labs/inference/attempts';
import type { Connection } from '@metro-labs/inference/model-config';
import { claudePrice, costMicros, RoutewayPrices } from '../src/prices.ts';

const OFFERED = ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-fable-5-1', 'claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5', 'claude-haiku-5-5'];

const call = (over: Partial<AttemptCall> = {}): AttemptCall => ({
  connection: 'conn0000001',
  provider: 'anthropic',
  model: 'claude-opus-5-5',
  lane: 'main',
  kind: 'main',
  attempt: 0,
  status: 200,
  outcome: 'ok',
  tokens: { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
  providerCost: null,
  ms: 10,
  firstTokenMs: 5,
  at: 0,
  ...over,
});

const conn = (over: Partial<Connection> = {}): Connection => ({ id: 'conn0000001', provider: 'anthropic', label: 'Anthropic', model: '', region: '', zdr: false, revision: 1, apiKey: 'sk-ant-key', claudeToken: '', codex: null, account: { email: null, plan: null, method: null }, signedOut: false, ...over });

const noRouteway = new RoutewayPrices(() => Promise.reject(new Error('offline')));

describe('the Claude price table', () => {
  test('every Claude model the Gateway page offers has a price', () => {
    for (const id of OFFERED) expect(claudePrice(id)).not.toBeNull();
  });

  test('the longest known id wins, and a dated id finds its model', () => {
    expect(claudePrice('claude-opus-5-5')?.input).toBe(4);
    expect(claudePrice('claude-opus-5')?.input).toBe(5);
    expect(claudePrice('claude-opus-5-5-20260901')?.input).toBe(4);
    expect(claudePrice('gpt-6')).toBeNull();
  });
});

describe('the cost of one call, in millionths of a dollar', () => {
  test('an Anthropic API key pays input, output, cache reads and both cache writes', () => {
    expect(costMicros(call(), conn(), noRouteway)).toBe(4_000_000);
    const mixed = call({ tokens: { input: 0, output: 1_000_000, cacheRead: 1_000_000, cacheWrite5m: 1_000_000, cacheWrite1h: 1_000_000 } });
    expect(costMicros(mixed, conn(), noRouteway)).toBe(20_000_000 + 200_000 + 5_000_000 + 8_000_000);
  });

  test('Haiku 5.5 costs five times more above 100,000 prompt tokens', () => {
    const short = call({ model: 'claude-haiku-5-5', tokens: { input: 100_000, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 } });
    const long = call({ model: 'claude-haiku-5-5', tokens: { input: 100_001, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 } });
    expect(costMicros(short, conn(), noRouteway)).toBe(10_000);
    expect(costMicros(long, conn(), noRouteway)).toBe(50_001);
  });

  test('a plan or a provider with its own prices has no cost; OpenRouter uses the cost it sent', () => {
    expect(costMicros(call(), conn({ apiKey: '', claudeToken: 'sk-ant-oat01-x' }), noRouteway)).toBeNull();
    expect(costMicros(call({ provider: 'bedrock' }), conn({ provider: 'bedrock' }), noRouteway)).toBeNull();
    expect(costMicros(call({ provider: 'codex' }), conn({ provider: 'codex' }), noRouteway)).toBeNull();
    expect(costMicros(call({ provider: 'openrouter', providerCost: 0.00123 }), conn({ provider: 'openrouter' }), noRouteway)).toBe(1230);
    expect(costMicros(call({ provider: 'openrouter' }), conn({ provider: 'openrouter' }), noRouteway)).toBeNull();
    expect(costMicros(call({ provider: 'routeway', model: 'deepseek-v4' }), conn({ provider: 'routeway' }), noRouteway)).toBeNull();
  });
});
