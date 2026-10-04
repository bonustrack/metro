import { describe, expect, test } from 'bun:test';
import { baseDomain, faviconUrl } from '../src/api/favicon.js';
import { matchModels, priceLabel, PROVIDERS, servedLabel, toModelSettings, toServed } from '../src/api/model.js';

describe('what the Model page reads from the daemon', () => {
  test('connections parse with their provider, and no credential ever appears', () => {
    const settings = toModelSettings({
      route: 'cn-1',
      ready: true,
      reason: null,
      connections: [
        { id: 'cn-1', provider: 'openrouter', label: 'Work', model: 'openai/gpt-5.2-codex', hasKey: true, zdr: true },
        { id: 'cn-2', provider: 'codex', label: 'ChatGPT', model: 'gpt-5.4', signedIn: true, account: 'less@x', plan: 'plus' },
        { id: 'cn-3', provider: 'mars' },
        'nope',
      ],
      usage: { 'cn-1': { at: '2026-09-22T10:00:00.000Z', windows: [{ label: 'Credits', used: 0.5 }] } },
    });
    expect(settings.route).toBe('cn-1');
    expect(settings.connections.map((c) => c.id)).toEqual(['cn-1', 'cn-2']);
    expect(settings.connections[0]).toEqual({ id: 'cn-1', provider: 'openrouter', label: 'Work', model: 'openai/gpt-5.2-codex', hasKey: true, region: '', zdr: true, signedIn: false, account: null, plan: null });
    expect(settings.connections[1]).toMatchObject({ provider: 'codex', signedIn: true, account: 'less@x', plan: 'plus' });
    expect(settings.usage['cn-1']?.windows[0]?.used).toBe(0.5);
    expect(JSON.stringify(settings)).not.toContain('apiKey');
  });

  test('a body with no connections is refused, and the five providers are the known list', () => {
    expect(toModelSettings({ route: '', connections: [] })).toMatchObject({ route: '', connections: [], reason: null });
    expect(() => toModelSettings({ route: '' })).toThrow(/unexpected/);
    expect(PROVIDERS.map((p) => p.id)).toEqual(['anthropic', 'bedrock', 'openrouter', 'codex', 'gemini']);
  });

  test('the last request names the provider it went to, and a half answer is no answer', () => {
    expect(toServed({ connection: 'cn-1', provider: 'openrouter', model: 'x/y', at: '2026-09-22T10:00:00.000Z' })).toEqual({
      connection: 'cn-1',
      provider: 'openrouter',
      model: 'x/y',
      at: '2026-09-22T10:00:00.000Z',
    });
    expect(toServed({ provider: 'openrouter', model: 'x/y' })).toBeNull();
    expect(servedLabel({ connection: 'c', provider: 'anthropic', model: 'claude-opus-5', at: 'now' })).toBe('claude-opus-5');
    expect(servedLabel({ connection: 'c', provider: 'codex', model: 'gpt-5.4', at: 'now' })).toBe('codex:gpt-5.4');
  });
});

describe('finding a model by typing', () => {
  const models = [
    { id: 'anthropic/claude-sonnet-4.5', name: 'Anthropic: Claude Sonnet 4.5' },
    { id: 'openai/gpt-5.2-codex', name: 'OpenAI: GPT-5.2 Codex' },
    { id: 'google/gemini-2.5-pro', name: 'Google: Gemini 2.5 Pro' },
  ];

  test('every typed word must appear somewhere in the id or the name', () => {
    expect(matchModels(models, 'claude').map((m) => m.id)).toEqual(['anthropic/claude-sonnet-4.5']);
    expect(matchModels(models, 'gpt codex').map((m) => m.id)).toEqual(['openai/gpt-5.2-codex']);
    expect(matchModels(models, '')).toHaveLength(3);
    expect(matchModels(models, 'nope')).toEqual([]);
    expect(matchModels(models, 'o', 2)).toHaveLength(2);
  });

  test('a price is shown per million tokens, free when both are zero, nothing when one is missing', () => {
    expect(priceLabel({ id: 'a', name: 'a', prompt: 0.000003, completion: 0.000015 })).toBe('$3 in · $15 out per 1M');
    expect(priceLabel({ id: 'a', name: 'a', prompt: 0, completion: 0 })).toBe('Free');
    expect(priceLabel({ id: 'a', name: 'a', prompt: 0.000001, completion: null })).toBe('');
  });
});

describe('the provider logo', () => {
  test('comes from the registrable domain of the provider host', () => {
    expect(baseDomain('openrouter.ai')).toBe('openrouter.ai');
    expect(baseDomain('mcp.aws.amazon.com')).toBe('amazon.com');
    expect(faviconUrl('https://aws.amazon.com', 32)).toContain('amazon.com');
  });
});
