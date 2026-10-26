import { beforeEach, describe, expect, test } from 'bun:test';
import { chatgptUsage, probes, probeUsage, type ProbeDeps } from '@metro-labs/inference/probes';
import { forgetUsage, noteUsageHeaders, usageOf } from '@metro-labs/inference/usage';
import { codexAccess, makeConnection } from './model-fixture.ts';

const NOW = new Date('2026-10-26T10:00:00.000Z');
const CLAUDE_TOKEN = `sk-ant-oat01-${'p'.repeat(80)}`;

interface Asked {
  url: string;
  headers: Record<string, string>;
  body: string | null;
}

function fakeFetch(answer: (url: string) => Response): { asked: Asked[]; deps: ProbeDeps } {
  const asked: Asked[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    asked.push({ url, headers: Object.fromEntries(new Headers(init?.headers).entries()), body: typeof init?.body === 'string' ? init.body : null });
    return answer(url);
  }) as typeof fetch;
  return { asked, deps: { fetchImpl, openrouterBase: 'https://or.test/api', chatgptBase: 'https://chatgpt.test/backend-api', anthropicBase: 'https://anthropic.test' } };
}

const json = (body: unknown, headers: Record<string, string> = {}): Response => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json', ...headers } });

beforeEach(() => {
  forgetUsage();
});

describe('which accounts are asked for their usage', () => {
  test('an OpenRouter key, a ChatGPT code sign-in and a Claude subscription; not Continue with ChatGPT, an API key or Bedrock', () => {
    expect(probes(makeConnection('openrouter', { apiKey: 'sk-or' }))).toBe(true);
    expect(probes(makeConnection('codex', { codex: codexAccess({ method: 'code' }) }))).toBe(true);
    expect(probes(makeConnection('anthropic', { claudeToken: CLAUDE_TOKEN }))).toBe(true);
    expect(probes(makeConnection('codex', { codex: codexAccess({ method: 'chatgpt' }) }))).toBe(false);
    expect(probes(makeConnection('anthropic', { apiKey: 'sk-ant' }))).toBe(false);
    expect(probes(makeConnection('openrouter'))).toBe(false);
    expect(probes(makeConnection('bedrock', { apiKey: 'k', region: 'us-east-1' }))).toBe(false);
    expect(probes(makeConnection('routeway', { apiKey: 'k' }))).toBe(false);
  });
});

describe('the OpenRouter credits', () => {
  test('the key spend becomes the Credits window', async () => {
    const { asked, deps } = fakeFetch(() => json({ data: { limit: 50, limit_remaining: 37.5, usage: 80 } }));
    const conn = makeConnection('openrouter', { apiKey: 'sk-or-secret' });
    expect(await probeUsage(conn, deps, NOW)).toBe(true);
    expect(asked.map((a) => [a.url, a.headers.authorization])).toEqual([['https://or.test/api/v1/key', 'Bearer sk-or-secret']]);
    expect(usageOf(conn.id)?.windows).toEqual([{ label: 'Credits', used: 0.25, resetAt: null, detail: '$12.50 of $50.00 used' }]);
  });
});

describe('a ChatGPT plan signed in with a code', () => {
  test('wham/usage gives the windows with their reset, the credits and the wall', async () => {
    const { asked, deps } = fakeFetch(() =>
      json({
        rate_limit: { limit_reached: true, primary_window: { used_percent: 42, limit_window_seconds: 18_000, reset_after_seconds: 600 }, secondary_window: { used_percent: '10', limit_window_seconds: 604_800, reset_at: 1_793_000_000 } },
        credits: { has_credits: true, balance: '12' },
        rate_limit_reached_type: { type: 'primary_window' },
      }),
    );
    const conn = makeConnection('codex', { codex: codexAccess({ method: 'code', accessToken: 'at-code', accountId: 'acct-1' }) });
    expect(await probeUsage(conn, deps, NOW)).toBe(true);
    expect(asked[0]?.url).toBe('https://chatgpt.test/backend-api/wham/usage');
    expect(asked[0]?.headers).toMatchObject({ authorization: 'Bearer at-code', 'chatgpt-account-id': 'acct-1', originator: 'codex_cli_rs' });
    expect(usageOf(conn.id)).toEqual({
      windows: [
        { label: '5-hour window', used: 0.42, resetAt: '2026-10-26T10:10:00.000Z', detail: null },
        { label: 'Weekly', used: 0.1, resetAt: new Date(1_793_000_000_000).toISOString(), detail: null },
        { label: 'Credits', used: null, resetAt: null, detail: '12 left' },
      ],
      note: 'primary window',
      at: NOW.toISOString(),
    });
  });

  test('an answer with nothing to read reports nothing, and a refusal says so', async () => {
    expect(chatgptUsage({ rate_limit: {} })).toBeNull();
    expect(chatgptUsage('no')).toBeNull();
    const { deps } = fakeFetch(() => new Response('no', { status: 401 }));
    const conn = makeConnection('codex', { codex: codexAccess({ method: 'code' }) });
    await expect(probeUsage(conn, deps, NOW)).rejects.toThrow('ChatGPT would not report its usage (401)');
    expect(usageOf(conn.id)).toBeUndefined();
  });

  test('Continue with ChatGPT is never asked', async () => {
    const { asked, deps } = fakeFetch(() => json({}));
    expect(await probeUsage(makeConnection('codex', { codex: codexAccess({ method: 'chatgpt' }) }), deps, NOW)).toBe(false);
    expect(asked).toEqual([]);
  });
});

describe('a Claude subscription', () => {
  const unified = { 'anthropic-ratelimit-unified-5h-utilization': '0.3', 'anthropic-ratelimit-unified-5h-reset': '1793000000', 'anthropic-ratelimit-unified-7d-utilization': '0.6' };

  test('a free token count with the token and the oauth beta, read for the plan windows, merged with what real answers said', async () => {
    const conn = makeConnection('anthropic', { claudeToken: CLAUDE_TOKEN });
    noteUsageHeaders('anthropic', conn.id, new Headers({ 'anthropic-ratelimit-unified-7d_sonnet-utilization': '0.9' }), new Date(NOW.getTime() - 60_000));
    const { asked, deps } = fakeFetch(() => json({ input_tokens: 3 }, unified));
    expect(await probeUsage(conn, deps, NOW)).toBe(true);
    expect(asked[0]?.url).toBe('https://anthropic.test/v1/messages/count_tokens');
    expect(asked[0]?.headers).toMatchObject({ authorization: `Bearer ${CLAUDE_TOKEN}`, 'anthropic-beta': 'oauth-2025-04-20' });
    expect(asked[0]?.headers['x-api-key']).toBeUndefined();
    expect(usageOf(conn.id)?.windows.map((w) => [w.label, w.used])).toEqual([['Weekly, Sonnet', 0.9], ['5-hour window', 0.3], ['Weekly, all models', 0.6]]);
  });

  test('an answer without plan headers changes nothing', async () => {
    const { deps } = fakeFetch(() => json({ input_tokens: 3 }, { 'anthropic-ratelimit-tokens-limit': '100', 'anthropic-ratelimit-tokens-remaining': '50' }));
    const conn = makeConnection('anthropic', { claudeToken: CLAUDE_TOKEN });
    expect(await probeUsage(conn, deps, NOW)).toBe(false);
    expect(usageOf(conn.id)).toBeUndefined();
  });
});
