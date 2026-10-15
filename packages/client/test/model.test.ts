import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { baseDomain, faviconUrl } from '../src/api/favicon.js';
import { clearAccount } from '../src/auth/account.js';
import { setCurrentServer } from '../src/auth/daemon.js';
import { configurePlatform, memoryKeyValue } from '../src/platform.js';
import { carriesCodeAndState, claudeModels, PROVIDERS, removeClaudeLogin, syncModel, toModelSettings, toServed, usageOf } from '../src/api/model.js';
import { matchModels, priceLabel, toModelOptions } from '../src/api/model-options.js';
import { LOCAL_SESSION, toRoute } from '../src/api/model-route.js';
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
  test('the effective route, its source, the delivered connections and the Claude logins, with no credential', () => {
    const settings = toModelSettings({
      route: { primary: { connection: 'orA00000001', model: 'openai/gpt-5.2' }, fallbacks: [{ connection: 'local:login0000001', model: 'claude-sonnet-5-5' }, { connection: 'x', model: '' }] },
      source: 'organization',
      connections: [
        { id: 'orA00000001', provider: 'openrouter', label: 'OpenRouter', model: 'openai/gpt-5.2', zdr: true, account: { email: null, plan: null, method: null } },
        { id: 'cdx00000001', provider: 'codex', label: 'ChatGPT', account: { email: 'less@x', plan: 'plus', method: 'chatgpt' }, signedOut: true },
        { id: 'gem00000001', provider: 'gemini', label: 'Gemini' },
        'nope',
      ],
      claude: [{ id: 'login0000001', email: 'less@claude', plan: 'max', savedAt: '2026-10-01' }, { email: 'no id' }],
      usage: { 'orA00000001': READING },
    });
    expect(settings.source).toBe('organization');
    expect(settings.route?.fallbacks).toEqual([{ connection: 'local:login0000001', model: 'claude-sonnet-5-5' }]);
    expect(settings.connections.map((c) => c.id)).toEqual(['orA00000001', 'cdx00000001', LOCAL_SESSION, 'local:login0000001']);
    expect(settings.connections[0]).toMatchObject({ provider: 'openrouter', hasKey: true, zdr: true, signedOut: false, account: null });
    expect(settings.connections[1]).toMatchObject({ hasKey: false, signedOut: true, account: 'less@x', plan: 'plus', method: 'chatgpt' });
    expect(settings.connections[3]).toMatchObject({ provider: 'anthropic', label: 'Claude subscription', account: 'less@claude', plan: 'max', hasKey: false });
    expect(settings.claude).toEqual([{ id: 'login0000001', email: 'less@claude', plan: 'max', savedAt: '2026-10-01' }]);
    expect(JSON.stringify(settings)).not.toContain('apiKey');
  });

  test('an answer from a daemon before organization models still reads, as the same route shape', () => {
    const old = toModelSettings({
      route: 'cn-1',
      connections: [{ id: 'cn-1', provider: 'codex', label: 'ChatGPT', model: 'gpt-5.4', signedIn: false }],
      fallbacks: [{ connection: 'cn-1', model: 'gpt-5.2' }],
      chain: [{ connection: 'passthrough', model: 'claude-x' }],
      usage: { passthrough: READING },
    });
    expect(old.route).toEqual({ primary: { connection: 'cn-1', model: 'gpt-5.4' }, fallbacks: [{ connection: 'cn-1', model: 'gpt-5.2' }] });
    expect(old.source).toBeNull();
    expect(old.connections[0]?.signedOut).toBe(true);
    expect(old.chain[0]?.connection).toBe(LOCAL_SESSION);
    const passthrough = toModelSettings({ route: '', connections: [], usage: { passthrough: READING } });
    expect(passthrough.route).toBeNull();
    expect(usageOf(passthrough, LOCAL_SESSION)?.windows[0]?.used).toBe(0.5);
    expect(toModelSettings({ route: '', connections: [], fallbacks: [{ connection: 'cn-1', model: 'x' }] }).route?.primary.connection).toBe(LOCAL_SESSION);
  });

  test('the box answer names the primary by id with its model, its sync state, and usage under the local ids', () => {
    const box = toModelSettings({
      source: 'agent',
      sync: { enrolled: true, at: '2026-10-15T10:00:00.000Z', error: null },
      route: 'local:login0000001',
      model: 'claude-sonnet-5-5',
      ready: true,
      reason: null,
      connections: [
        { id: 'local:login0000001', provider: 'anthropic', label: 'Claude', model: '', hasKey: false, signedIn: true, signedOut: false, account: 'own@claude', plan: 'max', method: null },
        { id: 'local:session', provider: 'anthropic', label: 'Session', hasKey: false, signedIn: false, signedOut: false, account: null },
      ],
      fallbacks: [{ connection: 'local:session', model: 'claude-haiku-4-5' }],
      claude: [{ id: 'login0000001', email: 'own@claude', plan: 'max', savedAt: '2026-10-01' }],
      usage: { 'local:session': READING, 'local:login0000001': { ...READING, windows: [{ label: 'Weekly', used: 0.2 }] } },
    });
    expect(box.route).toEqual({ primary: { connection: 'local:login0000001', model: 'claude-sonnet-5-5' }, fallbacks: [{ connection: 'local:session', model: 'claude-haiku-4-5' }] });
    expect(box.sync).toEqual({ enrolled: true, at: '2026-10-15T10:00:00.000Z', error: null });
    expect(box.connections.map((c) => [c.id, c.label, c.account])).toEqual([['local:login0000001', 'Claude', 'own@claude'], ['local:session', 'Session', null]]);
    expect(usageOf(box, 'local:login0000001')?.windows[0]?.used).toBe(0.2);
    expect(usageOf(box, LOCAL_SESSION)?.windows[0]?.used).toBe(0.5);
    expect(toModelSettings({ route: '', source: null, sync: { enrolled: false }, connections: [] }).sync).toEqual({ enrolled: false, at: null, error: null });
  });

  test('a body with neither connections nor a route is refused, and the four providers are the known list', () => {
    expect(toModelSettings({ route: null, source: null }).route).toBeNull();
    expect(() => toModelSettings({ ready: true })).toThrow(/unexpected/);
    expect(PROVIDERS.map((p) => p.id)).toEqual(['anthropic', 'bedrock', 'openrouter', 'codex']);
  });

  test('usage of a Claude login is found under its own id when the box keys it so', () => {
    const settings = toModelSettings({ route: null, connections: [], claude: [{ id: 'login0000001' }], usage: { login0000001: READING } });
    expect(usageOf(settings, 'local:login0000001')?.windows[0]?.used).toBe(0.5);
    expect(usageOf(settings, 'orA00000001')).toBeUndefined();
  });

  test('a route needs a primary, and fallbacks need a named model unless they use a login of the box', () => {
    expect(toRoute({ fallbacks: [{ connection: 'a', model: 'b' }] })).toBeNull();
    expect(toRoute({ primary: { connection: 'a', model: '' }, fallbacks: [{ connection: 'b', model: '' }, { connection: 'c', model: 'm' }] })).toEqual({ primary: { connection: 'a', model: '' }, fallbacks: [{ connection: 'c', model: 'm' }] });
    const local = [{ connection: LOCAL_SESSION, model: '' }, { connection: 'local:login0000001', model: '' }];
    expect(toRoute({ primary: { connection: 'a', model: 'm' }, fallbacks: local })?.fallbacks).toEqual(local);
  });

  test('the last request names the connection it went to, and a half answer is no answer', () => {
    expect(toServed({ connection: 'passthrough', provider: 'anthropic', model: 'x', at: '2026-10-15T10:00:00.000Z' })?.connection).toBe(LOCAL_SESSION);
    expect(toServed({ provider: 'openrouter', model: 'x/y' })).toBeNull();
  });

  test('removing a box Claude login is a DELETE on the box', async () => {
    serve({});
    await removeClaudeLogin('login0000001');
    expect(calls).toEqual([{ url: 'https://box.example.ts.net/api/model/claude/login0000001', method: 'DELETE' }]);
  });

  test('sync is a POST and the Claude model list a GET on the selected box', async () => {
    serve({ route: null, connections: [] });
    await syncModel();
    expect(calls).toEqual([{ url: 'https://box.example.ts.net/api/model/sync', method: 'POST' }]);
    serve({ models: [{ id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' }, 'claude-haiku-4-5'] });
    expect(await claudeModels()).toEqual([{ id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', price: '', zdr: null }, { id: 'claude-haiku-4-5', name: 'claude-haiku-4-5', price: '', zdr: null }]);
    expect(calls).toEqual([{ url: 'https://box.example.ts.net/api/model/claude-models', method: 'GET' }]);
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
});

describe('the provider logo', () => {
  test('comes from the registrable domain of the provider host', () => {
    expect(baseDomain('openrouter.ai')).toBe('openrouter.ai');
    expect(faviconUrl('https://aws.amazon.com', 32)).toContain('amazon.com');
  });
});
