import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { baseDomain, faviconUrl } from '../src/api/favicon.js';
import { clearAccount } from '../src/auth/account.js';
import { setCurrentServer } from '../src/auth/daemon.js';
import { configurePlatform, memoryKeyValue } from '../src/platform.js';
import { carriesCodeAndState, PROVIDERS, syncModel, toModelSettings, toServed, usageOf } from '../src/api/model.js';
import { contextLabel, matchModels, priceLabel, toModelOptions } from '../src/api/model-options.js';
import { toRoute } from '../src/api/model-route.js';
import { installTestAccount } from './account-fixture.js';

const realFetch = globalThis.fetch;
let calls: { url: string; method: string | undefined }[] = [];

function serve(body: unknown): void {
  calls = [];
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method });
    return Promise.resolve(Response.json(body));
  }) as unknown as typeof fetch;
}

beforeAll(() => {
  configurePlatform({ kv: memoryKeyValue() });
  installTestAccount();
  setCurrentServer({ id: 'box00000001', host: 'box.example.ts.net' });
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

afterAll(() => {
  setCurrentServer(null);
  clearAccount();
});

const READING = { at: '2026-10-15T10:00:00.000Z', windows: [{ label: 'Weekly', used: 0.5 }] };

describe('what the Model page reads from the box', () => {
  test('the effective route, its source and the delivered connections, with no credential', () => {
    const settings = toModelSettings({
      route: 'orA00000001',
      model: 'openai/gpt-5.2',
      fallbacks: [{ connection: 'antA0000001', model: 'claude-sonnet-5-5' }, { connection: 'x', model: '' }],
      source: 'organization',
      connections: [
        { id: 'orA00000001', provider: 'openrouter', label: 'OpenRouter', model: 'openai/gpt-5.2', zdr: true, account: { email: null, plan: null, method: null } },
        { id: 'cdx00000001', provider: 'codex', label: 'ChatGPT', account: { email: 'less@x', plan: 'plus', method: 'chatgpt' }, signedOut: true },
        { id: 'antA0000001', provider: 'anthropic', label: 'Max plan', subscription: true, hasKey: false },
        { id: 'gem00000001', provider: 'gemini', label: 'Gemini' },
        'nope',
      ],
      usage: { 'orA00000001': READING },
    });
    expect(settings.source).toBe('organization');
    expect(settings.route).toEqual({ primary: { connection: 'orA00000001', model: 'openai/gpt-5.2' }, fallbacks: [{ connection: 'antA0000001', model: 'claude-sonnet-5-5' }] });
    expect(settings.connections.map((c) => c.id)).toEqual(['orA00000001', 'cdx00000001', 'antA0000001']);
    expect(settings.connections[0]).toMatchObject({ provider: 'openrouter', hasKey: true, zdr: true, signedOut: false, account: null });
    expect(settings.connections[1]).toMatchObject({ hasKey: false, signedOut: true, account: 'less@x', plan: 'plus', method: 'chatgpt' });
    expect(settings.connections[0]?.subscription).toBe(false);
    expect(settings.connections[2]).toMatchObject({ provider: 'anthropic', label: 'Max plan', subscription: true, hasKey: false });
    expect(settings).not.toHaveProperty('claude');
    expect(JSON.stringify(settings)).not.toContain('apiKey');
  });

  test('no primary is no route, with or without fallbacks, and only the box answer fields count', () => {
    const bare = toModelSettings({ route: '', model: '', connections: [{ id: 'cn-1', provider: 'codex', label: 'ChatGPT', signedIn: false }] });
    expect(bare.route).toBeNull();
    expect(bare.source).toBeNull();
    expect(bare.connections[0]?.signedOut).toBe(false);
    expect(toModelSettings({ route: '', connections: [], fallbacks: [{ connection: 'cn-1', model: 'x' }] }).route).toBeNull();
    expect(toModelSettings({ route: 'cn-1', connections: [{ id: 'cn-1', provider: 'codex', model: 'gpt-5.4' }] }).route?.primary).toEqual({ connection: 'cn-1', model: '' });
  });

  test('the box answer names the primary by id with its model, its sync state, and usage by connection id', () => {
    const box = toModelSettings({
      source: 'agent',
      sync: { enrolled: true, at: '2026-10-15T10:00:00.000Z', error: null },
      route: 'antA0000001',
      model: 'claude-sonnet-5-5',
      ready: true,
      reason: null,
      connections: [
        { id: 'antA0000001', provider: 'anthropic', label: 'Claude', model: '', hasKey: false, subscription: true, signedOut: false, account: null, plan: null, method: null },
        { id: 'antB0000001', provider: 'anthropic', label: 'Key', hasKey: true, subscription: false, signedOut: false, account: null },
      ],
      fallbacks: [{ connection: 'antB0000001', model: 'claude-haiku-4-5' }],
      usage: { antB0000001: READING, antA0000001: { ...READING, windows: [{ label: 'Weekly', used: 0.2 }] } },
    });
    expect(box.route).toEqual({ primary: { connection: 'antA0000001', model: 'claude-sonnet-5-5' }, fallbacks: [{ connection: 'antB0000001', model: 'claude-haiku-4-5' }] });
    expect(box.sync).toEqual({ enrolled: true, at: '2026-10-15T10:00:00.000Z', error: null });
    expect(box.connections.map((c) => [c.id, c.label, c.subscription, c.hasKey])).toEqual([['antA0000001', 'Claude', true, false], ['antB0000001', 'Key', false, true]]);
    expect(usageOf(box, 'antA0000001')?.windows[0]?.used).toBe(0.2);
    expect(usageOf(box, 'antB0000001')?.windows[0]?.used).toBe(0.5);
    expect(toModelSettings({ route: '', source: null, sync: { enrolled: false }, connections: [] }).sync).toEqual({ enrolled: false, at: null, error: null });
  });

  test('a body without the route id and the connections list is refused, and the five providers are the known list', () => {
    expect(() => toModelSettings({ ready: true })).toThrow(/unexpected/);
    expect(() => toModelSettings({ route: null, connections: [] })).toThrow(/unexpected/);
    expect(() => toModelSettings({ route: { primary: { connection: 'a', model: 'm' }, fallbacks: [] }, connections: [] })).toThrow(/unexpected/);
    expect(() => toModelSettings({ route: '' })).toThrow(/unexpected/);
    expect(PROVIDERS.map((p) => p.id)).toEqual(['anthropic', 'bedrock', 'openrouter', 'codex', 'routeway']);
  });

  test('a route needs a primary, and every fallback needs a named model', () => {
    expect(toRoute({ fallbacks: [{ connection: 'a', model: 'b' }] })).toBeNull();
    expect(toRoute({ primary: { connection: 'a', model: '' }, fallbacks: [{ connection: 'b', model: '' }, { connection: 'c', model: 'm' }] })).toEqual({ primary: { connection: 'a', model: '' }, fallbacks: [{ connection: 'c', model: 'm' }] });
    expect(toRoute({ primary: { connection: 'a', model: 'm' }, fallbacks: [{ connection: 'local:session', model: '' }] })?.fallbacks).toEqual([]);
  });

  test('the last request names the connection it went to, and a half answer is no answer', () => {
    expect(toServed({ connection: 'antA0000001', provider: 'anthropic', model: 'x', at: '2026-10-15T10:00:00.000Z' })?.connection).toBe('antA0000001');
    expect(toServed({ provider: 'openrouter', model: 'x/y' })).toBeNull();
  });

  test('sync is a POST on the selected box', async () => {
    serve({ route: '', connections: [] });
    await syncModel();
    expect(calls).toEqual([{ url: 'https://box.example.ts.net/api/model/sync', method: 'POST' }]);
  });
});

describe('the ChatGPT sign-in address pasted back', () => {
  test('finishes on its own only once it carries both code= and state=', () => {
    expect(carriesCodeAndState('http://127.0.0.1:1455/auth/callback?code=ac_1&scope=openid&state=st_1&client_id=oaiapp_1')).toBe(true);
    expect(carriesCodeAndState(' ?code=ac_1&state=st_1 ')).toBe(true);
    expect(carriesCodeAndState('http://127.0.0.1:1455/auth/callback?code=ac_1')).toBe(false);
    expect(carriesCodeAndState('http://127.0.0.1:1455/auth/callback?code=&state=st_1')).toBe(false);
    expect(carriesCodeAndState('http://127.0.0.1:1455/auth/callback?unicode=x&mystate=y')).toBe(false);
    expect(carriesCodeAndState('')).toBe(false);
  });
});

describe('model lists', () => {
  const models = [
    { id: 'anthropic/claude-sonnet-4.5', name: 'Anthropic: Claude Sonnet 4.5', price: '', zdr: null },
    { id: 'openai/gpt-5.2-codex', name: 'OpenAI: GPT-5.2 Codex', price: '', zdr: null },
    { id: 'google/gemini-2.5-pro', name: 'Google: Gemini 2.5 Pro', price: '', zdr: null },
  ];

  test('every typed word must appear somewhere in the id or the name', () => {
    expect(matchModels(models, 'claude').map((m) => m.id)).toEqual(['anthropic/claude-sonnet-4.5']);
    expect(matchModels(models, 'gpt codex').map((m) => m.id)).toEqual(['openai/gpt-5.2-codex']);
    expect(matchModels(models, '')).toHaveLength(3);
    expect(matchModels(models, 'o', 2)).toHaveLength(2);
  });

  test('a price is a label as given, or per million tokens from per-token numbers', () => {
    expect(priceLabel(0.000003, 0.000015)).toBe('$3 in · $15 out per 1M');
    expect(priceLabel(0, 0)).toBe('Free');
    expect(priceLabel(0.000001, null)).toBe('');
    expect(toModelOptions({ models: [
      { id: 'a', price: '$1 per 1M' },
      { id: 'b', price: { prompt: 0, completion: 0 }, zdr: true },
      { id: 'c', name: 'C', price: { prompt: 0.000003, completion: 0.000015 }, zdr: false },
      { id: 'd', price: { prompt: null, completion: 0.000015 } },
      { id: 'e', prompt: 0.000003, completion: 0.000015 },
      { name: 'no id' },
    ] })).toEqual([
      { id: 'a', name: 'a', price: '$1 per 1M', zdr: null },
      { id: 'b', name: 'b', price: 'Free', zdr: true },
      { id: 'c', name: 'C', price: '$3 in · $15 out per 1M', zdr: false },
      { id: 'd', name: 'd', price: '', zdr: null },
      { id: 'e', name: 'e', price: '$3 in · $15 out per 1M', zdr: null },
    ]);
    expect(() => toModelOptions({})).toThrow(/unexpected/);
  });

  test('a context window reads in thousands or millions of tokens, and only when the list gives one', () => {
    expect(contextLabel(1_050_000)).toBe('1.05M context');
    expect(contextLabel(1_000_000)).toBe('1M context');
    expect(contextLabel(131_072)).toBe('131K context');
    expect(contextLabel(0)).toBe('');
    expect(contextLabel('200000')).toBe('');
    expect(toModelOptions({ models: [{ id: 'claude-sonnet-5.5', name: 'Claude Sonnet 5.5', price: { prompt: 0.000002, completion: 0.00001 }, context: 1_000_000 }, { id: 'x' }] })).toEqual([
      { id: 'claude-sonnet-5.5', name: 'Claude Sonnet 5.5', price: '$2 in · $10 out per 1M', zdr: null, context: '1M context' },
      { id: 'x', name: 'x', price: '', zdr: null },
    ]);
  });
});

describe('the provider logo', () => {
  test('comes from the registrable domain of the provider host', () => {
    expect(baseDomain('openrouter.ai')).toBe('openrouter.ai');
    expect(faviconUrl('https://aws.amazon.com', 32)).toContain('amazon.com');
  });
});
