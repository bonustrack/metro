import { describe, expect, test } from 'bun:test';
import { toModelSettings, usesKey, type ConnectionRow } from '../src/api/model.js';
import { connectionDetail, pickRows, providerLabel, routedConnection, routedUsage, typedRow } from '../src/api/providers.js';

const row = (over: Partial<ConnectionRow> & { id: string; provider: ConnectionRow['provider'] }): ConnectionRow => ({
  label: over.provider,
  model: '',
  hasKey: false,
  subscription: false,
  region: '',
  zdr: false,
  signedOut: false,
  account: null,
  plan: null,
  method: null,
  ...over,
});

const window = { label: 'Weekly', used: 0.03, resetAt: null, detail: null };
const usage = { 'cn-or': { windows: [window], note: null, at: '2026-09-29T13:00:00Z' }, 'local:session': { windows: [{ ...window, used: 0.7 }], note: null, at: '2026-09-29T13:00:00Z' } };

describe('the usage shown for the model in use', () => {
  test('a routed connection shows its own usage, and no route shows none', () => {
    const routed = toModelSettings({ route: 'cn-or', model: 'x', fallbacks: [], connections: [{ id: 'cn-or', provider: 'openrouter', label: 'Work' }], usage });
    expect(routedConnection(routed)?.label).toBe('Work');
    expect(routedUsage(routed)?.windows[0]?.used).toBe(0.03);
    const bare = toModelSettings({ route: '', connections: [], usage });
    expect(routedConnection(bare)).toBeUndefined();
    expect(routedUsage(bare)).toBeUndefined();
    expect(routedUsage(toModelSettings({ route: '', connections: [] }))).toBeUndefined();
    expect(routedConnection(toModelSettings({ route: 'gone', model: 'x', fallbacks: [], connections: [] }))).toBeUndefined();
  });
});

describe('what a connection card says', () => {
  test('each detail line names what it holds, never the secret', () => {
    expect(connectionDetail(row({ id: 'a', provider: 'bedrock', hasKey: true, region: 'eu-central-1' }))).toBe('API key stored · eu-central-1');
    expect(connectionDetail(row({ id: 'a', provider: 'bedrock', hasKey: true }))).toBe('API key stored · no region');
    expect(connectionDetail(row({ id: 'a', provider: 'openrouter', hasKey: true, zdr: true }))).toBe('API key stored · zero data retention');
    expect(connectionDetail(row({ id: 'a', provider: 'anthropic', subscription: true }))).toBe('Claude subscription');
    expect(connectionDetail(row({ id: 'a', provider: 'anthropic', subscription: true, signedOut: true }))).toBe('signed out, sign in again');
    expect(connectionDetail(row({ id: 'a', provider: 'anthropic', hasKey: true }))).toBe('API key stored');
    expect(connectionDetail(row({ id: 'a', provider: 'codex', account: 'less@x' }))).toBe('less@x');
    expect(connectionDetail(row({ id: 'a', provider: 'codex', signedOut: true }))).toBe('signed out, sign in again');
    expect(connectionDetail(row({ id: 'a', provider: 'anthropic', hasKey: true, signedOut: true }))).toBe('no key yet, add one');
    expect(providerLabel('codex')).toBe('Codex (ChatGPT)');
    expect(usesKey('openrouter')).toBe(true);
    expect(usesKey('codex')).toBe(false);
  });
});

describe('the model picker of one connection', () => {
  const bedrock = row({ id: 'cn-bed', provider: 'bedrock', label: 'AWS', hasKey: true });
  const models = [{ id: 'eu.anthropic.claude-sonnet-4-6', name: 'Claude Sonnet 4.6', price: '', zdr: null }, { id: 'eu.anthropic.claude-opus-4-6', name: 'Claude Opus 4.6', price: '', zdr: null }];

  test('the listed models are offered as they are, and the current one is marked', () => {
    const rows = pickRows({ models, connection: bedrock, query: '', current: 'eu.anthropic.claude-opus-4-6' });
    expect(rows.map((r) => r.id)).toEqual(['eu.anthropic.claude-sonnet-4-6', 'eu.anthropic.claude-opus-4-6']);
    expect(rows.filter((r) => r.current).map((r) => r.id)).toEqual(['eu.anthropic.claude-opus-4-6']);
    expect(pickRows({ models: [], connection: bedrock, query: '', current: '' })).toEqual([]);
  });

  test('zero data retention on an OpenRouter connection hides the models that have no such endpoint', () => {
    const listed = [{ id: 'a/kept', name: 'kept', price: '', zdr: true }, { id: 'a/gone', name: 'gone', price: '', zdr: false }, { id: 'a/unknown', name: 'unknown', price: '', zdr: null }];
    const on = row({ id: 'or', provider: 'openrouter', hasKey: true, zdr: true });
    expect(pickRows({ models: listed, connection: on, query: '', current: '' }).map((r) => r.id)).toEqual(['a/kept', 'a/unknown']);
    expect(pickRows({ models: listed, connection: { ...on, zdr: false }, query: '', current: '' })).toHaveLength(3);
  });

  test('a query searches, and a typed id is offered unless it is already listed', () => {
    expect(pickRows({ models, connection: bedrock, query: 'opus', current: '' }).map((r) => r.id)).toEqual(['eu.anthropic.claude-opus-4-6']);
    expect(typedRow({ models, connection: bedrock, query: ' eu.anthropic.claude-haiku ', current: '' })).toMatchObject({ id: 'eu.anthropic.claude-haiku', connection: 'cn-bed', label: 'AWS', current: false });
    expect(typedRow({ models, connection: bedrock, query: 'eu.anthropic.claude-opus-4-6', current: '' })).toBeNull();
    expect(typedRow({ models, connection: bedrock, query: '', current: '' })).toBeNull();
  });
});
