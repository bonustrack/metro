import { beforeEach, describe, expect, test } from 'bun:test';
import {
  anthropicUsage,
  claudeLoginUsage,
  codexUsage,
  codexUsageBody,
  forgetUsage,
  mayProbe,
  noteUsageHeaders,
  openrouterUsage,
  tallyTokens,
  usageSeen,
  UsageScanner,
  windowLabel,
} from '../src/gateway/usage.ts';
import { usageIn } from '../src/claude/usage-probe.ts';
import { codexUsageAnswer, recordedClaudeUsageAnswer } from './usage-fixtures.ts';

const NOW = new Date('2026-09-17T10:00:00.000Z');
const RESET = Math.floor(new Date('2026-09-17T12:30:00.000Z').getTime() / 1000);

beforeEach(() => {
  forgetUsage();
});

describe('what Anthropic says about the login on every answer', () => {
  test('the unified windows come through as fractions with their reset times', () => {
    const usage = anthropicUsage(
      new Headers({
        'anthropic-ratelimit-unified-5h-utilization': '0.34',
        'anthropic-ratelimit-unified-5h-status': 'allowed',
        'anthropic-ratelimit-unified-5h-reset': String(RESET),
        'anthropic-ratelimit-unified-7d-utilization': '0.61',
        'anthropic-ratelimit-unified-7d-status': 'allowed',
        'anthropic-ratelimit-unified-7d-reset': '2026-09-19T09:00:00Z',
      }),
      NOW,
    );
    expect(usage).toEqual({
      windows: [
        { label: '5-hour window', used: 0.34, resetAt: '2026-09-17T12:30:00.000Z', detail: null },
        { label: 'Weekly', used: 0.61, resetAt: '2026-09-19T09:00:00.000Z', detail: null },
      ],
      note: null,
      at: NOW.toISOString(),
    });
  });

  test('a window past its limit is named, and a value out of range is clamped', () => {
    const usage = anthropicUsage(
      new Headers({
        'anthropic-ratelimit-unified-5h-utilization': '1.7',
        'anthropic-ratelimit-unified-5h-status': 'rate_limited',
      }),
      NOW,
    );
    expect(usage?.windows[0]).toMatchObject({ used: 1, detail: 'rate limited' });
    expect(usage?.note).toBe('5-hour window: rate limited');
  });

  test('an API key answers with per-minute token limits instead, read as used-of-limit', () => {
    const usage = anthropicUsage(
      new Headers({
        'anthropic-ratelimit-tokens-limit': '400000',
        'anthropic-ratelimit-tokens-remaining': '100000',
        'anthropic-ratelimit-tokens-reset': '2026-09-17T10:01:00Z',
      }),
      NOW,
    );
    expect(usage?.windows).toEqual([
      { label: 'Tokens per minute', used: 0.75, resetAt: '2026-09-17T10:01:00.000Z', detail: '100,000 of 400,000 left' },
    ]);
    expect(usage?.note).toBeNull();
  });

  test('a reset given in milliseconds is not read as a date fifty thousand years out', () => {
    const usage = anthropicUsage(
      new Headers({
        'anthropic-ratelimit-unified-5h-utilization': '0.1',
        'anthropic-ratelimit-unified-5h-reset': String(RESET * 1000),
      }),
      NOW,
    );
    expect(usage?.windows[0]?.resetAt).toBe('2026-09-17T12:30:00.000Z');
  });

  test('an answer with no rate-limit headers reports nothing rather than zeros', () => {
    expect(anthropicUsage(new Headers({ 'content-type': 'application/json' }), NOW)).toBeNull();
    expect(anthropicUsage(new Headers({ 'anthropic-ratelimit-unified-5h-utilization': 'soon' }), NOW)).toBeNull();
  });
});

describe('what the Codex backend says on every answer', () => {
  test('primary and secondary windows, labelled by their length, with absolute resets', () => {
    const usage = codexUsage(
      new Headers({
        'x-codex-primary-used-percent': '42',
        'x-codex-primary-window-minutes': '300',
        'x-codex-primary-reset-at': String(RESET),
        'x-codex-secondary-used-percent': '8.5',
        'x-codex-secondary-window-minutes': '10080',
        'x-codex-secondary-reset-at': String(RESET + 86_400),
      }),
      NOW,
    );
    expect(usage?.windows).toEqual([
      { label: '5-hour window', used: 0.42, resetAt: '2026-09-17T12:30:00.000Z', detail: null },
      { label: 'Weekly', used: 0.085, resetAt: '2026-09-18T12:30:00.000Z', detail: null },
    ]);
    expect(usage?.note).toBeNull();
  });

  test('a relative reset is anchored to now, and a reached limit is named', () => {
    const usage = codexUsage(
      new Headers({
        'x-codex-primary-used-percent': '100',
        'x-codex-primary-window-minutes': '300',
        'x-codex-primary-reset-after-seconds': '900',
        'x-codex-rate-limit-reached-type': 'usage_limit_reached',
      }),
      NOW,
    );
    expect(usage?.windows[0]?.resetAt).toBe('2026-09-17T10:15:00.000Z');
    expect(usage?.note).toBe('usage limit reached');
  });

  test('an answer with no Codex headers reports nothing, not two empty windows', () => {
    expect(codexUsage(new Headers({ 'content-type': 'application/json' }), NOW)).toBeNull();
    expect(codexUsage(new Headers({ 'x-codex-primary-used-percent': 'lots' }), NOW)).toBeNull();
  });

  test('window labels read like a person would say them', () => {
    expect(windowLabel(300)).toBe('5-hour window');
    expect(windowLabel(10080)).toBe('Weekly');
    expect(windowLabel(1440)).toBe('1-day window');
    expect(windowLabel(45)).toBe('45-minute window');
    expect(windowLabel(null)).toBe('Usage window');
  });
});

describe('what the page is handed', () => {
  test('the latest per provider is kept, an answer without headers does not erase it', () => {
    noteUsageHeaders('anthropic', 'cn-1', new Headers({ 'anthropic-ratelimit-unified-5h-utilization': '0.2' }), NOW);
    noteUsageHeaders('anthropic', 'cn-1', new Headers({}), new Date(NOW.getTime() + 1000));
    noteUsageHeaders('codex', 'cn-2', new Headers({ 'x-codex-primary-used-percent': '10', 'x-codex-primary-window-minutes': '300' }), NOW);
    const seen = usageSeen();
    expect(Object.keys(seen).sort()).toEqual(['cn-1', 'cn-2']);
    expect(seen['cn-1']?.windows[0]?.used).toBe(0.2);
    expect(seen['cn-1']?.at).toBe(NOW.toISOString());
  });

  test('a Codex credit balance shows only when the account holds credits', () => {
    const withCredits = codexUsage(
      new Headers({ 'x-codex-primary-used-percent': '1', 'x-codex-credits-has-credits': 'true', 'x-codex-credits-balance': '2500' }),
      NOW,
    );
    expect(withCredits?.windows.at(-1)).toEqual({ label: 'Credits', used: null, resetAt: null, detail: '2,500 left' });
    const without = codexUsage(new Headers({ 'x-codex-primary-used-percent': '1', 'x-codex-credits-balance': '2500' }), NOW);
    expect(without?.windows.map((w) => w.label)).toEqual(['Usage window']);
  });

  test('an OpenRouter key is one Credits window: spent of its limit, or plain spend when it has none', () => {
    expect(openrouterUsage({ limit: 50, remaining: 37.5, spent: 80 }, NOW)).toEqual({
      windows: [{ label: 'Credits', used: 0.25, resetAt: null, detail: '$12.50 of $50.00 used' }],
      note: null,
      at: NOW.toISOString(),
    });
    expect(openrouterUsage({ limit: 50, remaining: null, spent: 10 }, NOW).windows[0]?.detail).toBe('$10.00 of $50.00 used');
    expect(openrouterUsage({ limit: null, remaining: null, spent: 3.5 }, NOW).windows[0]).toEqual({
      label: 'Credits',
      used: null,
      resetAt: null,
      detail: '$3.50 used, no limit on this key',
    });
  });

  test('a probe runs once per key within its interval, and forgetting the usage lets it run again', () => {
    expect(mayProbe('cn-1', 0, 1000)).toBe(true);
    expect(mayProbe('cn-1', 999, 1000)).toBe(false);
    expect(mayProbe('cn-2', 999, 1000)).toBe(true);
    expect(mayProbe('cn-1', 1000, 1000)).toBe(true);
    forgetUsage();
    expect(mayProbe('cn-1', 1001, 1000)).toBe(true);
  });
});

describe('usage asked for before any request', () => {
  test('the ChatGPT usage endpoint reads like the Codex headers, credits included', () => {
    expect(codexUsageBody(codexUsageAnswer, NOW)).toEqual({
      windows: [
        { label: '5-hour window', used: 0.07, resetAt: '2026-09-29T13:00:00.000Z', detail: null },
        { label: 'Weekly', used: 0.03, resetAt: '2026-10-05T01:20:00.000Z', detail: null },
        { label: 'Credits', used: null, resetAt: null, detail: '120 left' },
      ],
      note: null,
      at: NOW.toISOString(),
    });
  });

  test('a reached Codex limit is named, a relative reset is anchored to now, and an empty answer reports nothing', () => {
    const walled = codexUsageBody(
      {
        rate_limit: { allowed: false, limit_reached: true, primary_window: { used_percent: 100, limit_window_seconds: 604800, reset_after_seconds: 900 } },
        rate_limit_reached_type: { type: 'rate_limit_reached' },
      },
      NOW,
    );
    expect(walled?.windows).toEqual([{ label: 'Weekly', used: 1, resetAt: '2026-09-17T10:15:00.000Z', detail: null }]);
    expect(walled?.note).toBe('rate limit reached');
    expect(codexUsageBody({ plan_type: 'plus', rate_limit: null, credits: { has_credits: false, balance: '0' } }, NOW)).toBeNull();
    expect(codexUsageBody('nope', NOW)).toBeNull();
  });

  test('the Claude Code login usage, as Claude Code answered it on this box, becomes the same windows as its headers', () => {
    const usage = claudeLoginUsage(usageIn(recordedClaudeUsageAnswer), NOW);
    expect(usage).toEqual({
      windows: [
        { label: '5-hour window', used: 0.11, resetAt: '2026-09-29T13:49:59.999Z', detail: null },
        { label: 'Weekly', used: 0.7, resetAt: '2026-09-30T23:59:59.999Z', detail: null },
        { label: 'Weekly, Fable', used: 0, resetAt: '2026-10-01T00:00:00.000Z', detail: null },
      ],
      note: null,
      at: NOW.toISOString(),
    });
  });

  test('the SDK model rows and the Sonnet window are read, a duplicate label is kept once, and no limits mean nothing', () => {
    const usage = claudeLoginUsage(
      {
        seven_day_sonnet: { utilization: 40, resets_at: '2026-09-20T00:00:00Z' },
        model_scoped: [{ display_name: 'Fable', utilization: 12.5, resets_at: null }],
        limits: [{ kind: 'weekly_scoped', percent: 12, scope: { model: { display_name: 'Fable' } } }, { kind: 'session', percent: 5 }],
      },
      NOW,
    );
    expect(usage?.windows).toEqual([
      { label: 'Weekly, Sonnet', used: 0.4, resetAt: '2026-09-20T00:00:00.000Z', detail: null },
      { label: 'Weekly, Fable', used: 0.125, resetAt: null, detail: null },
    ]);
    expect(claudeLoginUsage(null, NOW)).toBeNull();
    expect(claudeLoginUsage({ five_hour: null, seven_day: null }, NOW)).toBeNull();
  });
});

describe('counting tokens on every answer, whatever the provider', () => {
  const START = 'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1200,"output_tokens":1,"cache_read_input_tokens":900,"cache_creation_input_tokens":0}}}\n\n';
  const DELTA = 'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":340}}\n\n';

  test('a streamed answer counts the input from message_start and the final output from message_delta, once', () => {
    const scanner = new UsageScanner('anthropic');
    scanner.feed(START);
    scanner.feed(DELTA);
    scanner.done(NOW);
    expect(usageSeen()['anthropic']?.tally).toEqual({ requests: 1, input: 1200, output: 340, cached: 900, since: NOW.toISOString() });
  });

  test('a line split across chunks is still read whole', () => {
    const scanner = new UsageScanner('openrouter');
    const whole = START + DELTA;
    for (let i = 0; i < whole.length; i += 7) scanner.feed(whole.slice(i, i + 7));
    scanner.done(NOW);
    expect(usageSeen()['openrouter']?.tally).toMatchObject({ requests: 1, input: 1200, output: 340 });
  });

  test('a whole JSON body with no newlines is read at the end', () => {
    const scanner = new UsageScanner('bedrock');
    scanner.feed('{"type":"message","usage":{"input_tokens":50,"output_tokens":7}}');
    scanner.done(NOW);
    expect(usageSeen()['bedrock']?.tally).toMatchObject({ requests: 1, input: 50, output: 7, cached: 0 });
  });

  test('an answer with no usage in it counts nothing, and the totals add up across answers', () => {
    const empty = new UsageScanner('codex');
    empty.feed('event: ping\ndata: {"type":"ping"}\n\n');
    empty.done(NOW);
    expect(usageSeen()['codex']).toBeUndefined();
    tallyTokens('codex', { input: 10, output: 2, cached: 0 }, NOW);
    tallyTokens('codex', { input: 30, output: 5, cached: 8 }, new Date(NOW.getTime() + 60_000));
    expect(usageSeen()['codex']?.tally).toEqual({ requests: 2, input: 40, output: 7, cached: 8, since: NOW.toISOString() });
    expect(usageSeen()['codex']?.windows).toEqual([]);
  });
});
