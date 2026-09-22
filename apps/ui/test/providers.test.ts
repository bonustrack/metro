import { describe, expect, test } from 'bun:test';
import { toModelSettings, type ConnectionRow } from '../src/api/model.js';
import { connectionDetail, DEFAULT_MODEL, modelLabel, pickRows, routedConnection, typedRow, usesKey } from '../src/api/providers.js';

const row = (over: Partial<ConnectionRow> & { id: string; provider: ConnectionRow['provider'] }): ConnectionRow => ({
  label: over.provider,
  model: '',
  hasKey: false,
  region: '',
  zdr: false,
  signedIn: false,
  account: null,
  plan: null,
  ...over,
});

const settings = toModelSettings({
  route: 'cn-or',
  ready: true,
  connections: [
    { id: 'cn-or', provider: 'openrouter', label: 'Work', model: 'google/gemini-3.8-flash', hasKey: true, zdr: true },
    { id: 'cn-or2', provider: 'openrouter', label: 'Personal', model: 'openai/gpt-5.4', hasKey: true },
    { id: 'cn-bed', provider: 'bedrock', label: 'AWS', region: 'eu-central-1', hasKey: true },
    { id: 'cn-cdx', provider: 'codex', label: 'ChatGPT', model: 'gpt-5.4', signedIn: true, account: 'less@x', plan: 'plus' },
  ],
});

describe('what a connection card says', () => {
  test('the routed one is found by id, and each detail line names what it holds, never the secret', () => {
    expect(routedConnection(settings)?.label).toBe('Work');
    expect(routedConnection({ ...settings, route: 'gone' })).toBeUndefined();
    expect(connectionDetail(row({ id: 'a', provider: 'bedrock', hasKey: true, region: 'eu-central-1' }))).toBe('API key stored · eu-central-1');
    expect(connectionDetail(row({ id: 'a', provider: 'bedrock' }))).toBe('no key · no region');
    expect(connectionDetail(row({ id: 'a', provider: 'openrouter', hasKey: true, zdr: true }))).toBe('API key stored · zero data retention');
    expect(connectionDetail(row({ id: 'a', provider: 'anthropic' }))).toBe('your Claude Code login');
    expect(connectionDetail(row({ id: 'a', provider: 'anthropic', hasKey: true }))).toBe('API key stored');
    expect(connectionDetail(row({ id: 'a', provider: 'codex', signedIn: true, account: 'less@x', plan: 'plus' }))).toBe('less@x (plus)');
    expect(modelLabel(row({ id: 'a', provider: 'bedrock' }))).toBe(DEFAULT_MODEL);
    expect(modelLabel(row({ id: 'a', provider: 'codex', model: 'gpt-5.4' }))).toBe('gpt-5.4');
    expect(usesKey('openrouter')).toBe(true);
    expect(usesKey('codex')).toBe(false);
  });
});

describe('the model picker across connections', () => {
  const models = {
    'cn-or': [
      { id: 'google/gemini-3.8-flash', name: 'Google: Gemini 3.8 Flash' },
      { id: 'openai/gpt-5.4', name: 'OpenAI: GPT-5.4' },
    ],
    'cn-or2': [{ id: 'openai/gpt-5.4', name: 'OpenAI: GPT-5.4' }],
    'cn-bed': [{ id: 'eu.anthropic.claude-sonnet-4-6', name: 'Claude Sonnet 4.6' }],
    'cn-cdx': [{ id: 'gpt-5.4', name: 'gpt-5.4' }],
  };
  const base = { models, connections: settings.connections, route: settings.route, zdr: null };

  test('All lists every connection, each row carries its name, and the routed model is marked', () => {
    const rows = pickRows({ ...base, chip: 'all', query: '' });
    expect(rows.map((r) => `${r.connection}:${r.id}`)).toEqual([
      'cn-or:google/gemini-3.8-flash',
      'cn-or:openai/gpt-5.4',
      'cn-or2:openai/gpt-5.4',
      'cn-bed:',
      'cn-bed:eu.anthropic.claude-sonnet-4-6',
      'cn-cdx:gpt-5.4',
    ]);
    expect(rows[0]?.label).toBe('Work');
    expect(rows.filter((r) => r.current).map((r) => r.connection)).toEqual(['cn-or']);
    expect(rows[3]?.name).toBe(DEFAULT_MODEL);
  });

  test('a chip narrows to one connection, a query searches, zero data retention filters that key only, and a typed id is offered under a chip', () => {
    expect(pickRows({ ...base, chip: 'cn-or2', query: '' }).map((r) => r.id)).toEqual(['openai/gpt-5.4']);
    expect(pickRows({ ...base, chip: 'all', query: 'gpt' }).map((r) => r.connection)).toEqual(['cn-or', 'cn-or2', 'cn-cdx']);
    const zdr = pickRows({ ...base, chip: 'all', query: '', zdr: new Set(['openai/gpt-5.4']) });
    expect(zdr.filter((r) => r.connection === 'cn-or').map((r) => r.id)).toEqual(['openai/gpt-5.4']);
    expect(zdr.filter((r) => r.connection === 'cn-or2').map((r) => r.id)).toEqual(['openai/gpt-5.4']);
    expect(typedRow({ ...base, chip: 'all', query: 'mistral/x' })).toBeNull();
    expect(typedRow({ ...base, chip: 'cn-or', query: ' mistral/x ' })).toMatchObject({ id: 'mistral/x', connection: 'cn-or', label: 'Work' });
    expect(typedRow({ ...base, chip: 'cn-cdx', query: 'gpt-5.4' })).toBeNull();
  });
});
