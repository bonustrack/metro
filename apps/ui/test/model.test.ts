import { describe, expect, test } from 'bun:test';
import { afterSave, draftOf, matchModels, patchOf, priceLabel, PROVIDERS, routeLabel, servedLabel, toModelSettings, toServed } from '../src/api/model';

describe('what the Model page reads from the daemon', () => {
  test('a full answer parses, keys arrive as booleans only', () => {
    const settings = toModelSettings({
      provider: 'openrouter',
      ready: true,
      reason: null,
      bedrock: { region: 'eu-central-1', model: '', hasKey: true },
      openrouter: { model: 'openai/gpt-5.2-codex', hasKey: true },
    });
    expect(settings.provider).toBe('openrouter');
    expect(settings.bedrock).toEqual({ region: 'eu-central-1', model: '', hasKey: true });
    expect(settings.openrouter).toEqual({ model: 'openai/gpt-5.2-codex', hasKey: true });
    expect(JSON.stringify(settings)).not.toContain('apiKey');
    expect(routeLabel(settings)).toBe('OpenRouter · openai/gpt-5.2-codex');
  });

  test('a missing block or an unknown provider never invents fields', () => {
    const bare = toModelSettings({ provider: 'anthropic', ready: true });
    expect(bare.bedrock).toEqual({ region: '', model: '', hasKey: false });
    expect(bare.reason).toBeNull();
    expect(bare.anthropic).toEqual({ model: '', hasKey: false });
    expect(routeLabel(bare)).toBe('Anthropic · the model Claude Code asks for · your Claude Code login');
    expect(routeLabel({ ...bare, anthropic: { model: 'claude-opus-5', hasKey: true } })).toBe('Anthropic · claude-opus-5 · the key on this page');
    expect(() => toModelSettings({ provider: 'mars' })).toThrow(/unexpected/);
    expect(PROVIDERS.map((p) => p.id)).toEqual(['anthropic', 'bedrock', 'openrouter', 'codex']);
    expect(bare.codex).toEqual({ model: '', signedIn: false, account: null, plan: null });
  });

  test('a route that is not ready says why', () => {
    const settings = toModelSettings({ provider: 'bedrock', ready: false, reason: 'Bedrock needs an API key: add it on the Model page.', bedrock: { region: '', model: 'eu.anthropic.claude-sonnet-4-6', hasKey: false } });
    expect(settings.reason).toContain('API key');
    expect(routeLabel(settings)).toBe('Amazon Bedrock · eu.anthropic.claude-sonnet-4-6');
  });
});

describe('what Save sends', () => {
  test('an empty key field keeps the stored key, a typed key replaces it, and forget clears it', () => {
    const settings = toModelSettings({ provider: 'bedrock', ready: true, bedrock: { region: 'eu-central-1', model: '', hasKey: true }, openrouter: { model: 'x/y', hasKey: true }, codex: { model: 'gpt-5.4' } });
    const draft = draftOf(settings);
    expect(draft.bedrockKey).toBe('');
    expect(patchOf(draft)).toEqual({ provider: 'bedrock', anthropic: { model: '' }, bedrock: { region: 'eu-central-1', model: '' }, openrouter: { model: 'x/y' }, codex: { model: 'gpt-5.4' } });
    expect(patchOf({ ...draft, anthropicKey: 'sk-ant-x', anthropicModel: 'claude-opus-5' }).anthropic).toEqual({ model: 'claude-opus-5', apiKey: 'sk-ant-x' });
    expect(patchOf({ ...draft, anthropicForget: true }).anthropic).toEqual({ model: '', apiKey: '' });
    expect(patchOf({ ...draft, bedrockKey: 'new-key' }).bedrock).toEqual({ region: 'eu-central-1', model: '', apiKey: 'new-key' });
    expect(patchOf({ ...draft, openrouterForget: true }).openrouter).toEqual({ model: 'x/y', apiKey: '' });
    expect(afterSave({ ...draft, bedrockKey: 'new-key', openrouterForget: true, anthropicKey: 'k' })).toMatchObject({ anthropicKey: '', anthropicForget: false, bedrockKey: '', bedrockForget: false, openrouterKey: '', openrouterForget: false, codexModel: 'gpt-5.4' });
  });
});

describe('finding an OpenRouter model by typing', () => {
  const models = [
    { id: 'anthropic/claude-sonnet-4.5', name: 'Anthropic: Claude Sonnet 4.5' },
    { id: 'openai/gpt-5.2-codex', name: 'OpenAI: GPT-5.2 Codex' },
    { id: 'google/gemini-2.5-pro', name: 'Google: Gemini 2.5 Pro' },
  ];

  test('every word must appear, in the id or the name, and the list is capped', () => {
    expect(matchModels(models, '').map((m) => m.id)).toEqual(models.map((m) => m.id));
    expect(matchModels(models, 'sonnet').map((m) => m.id)).toEqual(['anthropic/claude-sonnet-4.5']);
    expect(matchModels(models, 'GPT').map((m) => m.id)).toEqual(['openai/gpt-5.2-codex']);
    expect(matchModels(models, 'google pro').map((m) => m.id)).toEqual(['google/gemini-2.5-pro']);
    expect(matchModels(models, 'claude gpt')).toEqual([]);
    expect(matchModels(models, '  ').map((m) => m.id)).toEqual(models.map((m) => m.id));
    expect(matchModels(models, '', 2)).toHaveLength(2);
  });
});

describe('the last request the gateway served', () => {
  test('is read only when it is whole, and reads as the route that carried it', () => {
    const row = { provider: 'codex', model: 'gpt-6-astra', at: '2026-09-08T09:00:00.000Z' };
    expect(toServed(row)).toEqual(row);
    expect(toServed({ ...row, model: '' })).toBeNull();
    expect(toServed({ provider: 'codex', model: 'gpt-6-astra' })).toBeNull();
    expect(toServed(null)).toBeNull();
    expect(servedLabel(row)).toBe('codex:gpt-6-astra');
    expect(servedLabel({ ...row, provider: 'anthropic', model: 'claude-sonnet-5' })).toBe('claude-sonnet-5');
    const settings = toModelSettings({ provider: 'codex', ready: true, bedrock: {}, openrouter: {}, codex: { model: 'gpt-6-astra' }, lastServed: row });
    expect(settings.lastServed).toEqual(row);
    expect(toModelSettings({ provider: 'anthropic', bedrock: {}, openrouter: {}, codex: {} }).lastServed).toBeNull();
  });
});

describe('what a model costs, on the row that offers it', () => {
  test('prices are per million tokens, free is named, and a model with no price shows none', () => {
    expect(priceLabel({ id: 'a', name: 'a', prompt: 0.00001, completion: 0.00005 })).toBe('$10 in · $50 out per 1M');
    expect(priceLabel({ id: 'a', name: 'a', prompt: 0.00000015, completion: 0.0000006 })).toBe('$0.15 in · $0.6 out per 1M');
    expect(priceLabel({ id: 'a', name: 'a', prompt: 0, completion: 0 })).toBe('Free');
    expect(priceLabel({ id: 'a', name: 'a', prompt: 0.000003, completion: null })).toBe('');
    expect(priceLabel({ id: 'a', name: 'a' })).toBe('');
  });
});
