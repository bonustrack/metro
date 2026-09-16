import { beforeEach, describe, expect, test } from 'bun:test';
import {
  anthropicUsage,
  codexUsage,
  forgetUsage,
  noteUsageHeaders,
  openrouterUsage,
  usageSeen,
  windowLabel,
} from '../src/gateway/usage.ts';

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
    noteUsageHeaders('anthropic', new Headers({ 'anthropic-ratelimit-unified-5h-utilization': '0.2' }), NOW);
    noteUsageHeaders('anthropic', new Headers({}), new Date(NOW.getTime() + 1000));
    noteUsageHeaders('codex', new Headers({ 'x-codex-primary-used-percent': '10', 'x-codex-primary-window-minutes': '300' }), NOW);
    const seen = usageSeen();
    expect(Object.keys(seen).sort()).toEqual(['anthropic', 'codex']);
    expect(seen.anthropic?.windows[0]?.used).toBe(0.2);
    expect(seen.anthropic?.at).toBe(NOW.toISOString());
  });

  test('OpenRouter credits are one window with the money spelled out', () => {
    expect(openrouterUsage(50, 12.4, NOW)).toEqual({
      windows: [{ label: 'Credits', used: 0.248, resetAt: null, detail: '$12.40 of $50.00 used' }],
      note: null,
      at: NOW.toISOString(),
    });
    expect(openrouterUsage(0, 0, NOW).windows[0]?.used).toBeNull();
  });
});
