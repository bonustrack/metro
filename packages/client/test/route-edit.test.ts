import { describe, expect, test } from 'bun:test';
import { localConnections, toConnection, type ConnectionRow } from '../src/api/model.js';
import { FALLBACKS_MAX, type ModelRoute } from '../src/api/model-route.js';
import {
  canAddFallback,
  changesOf,
  draftOf,
  movedFallback,
  problemOf,
  promotedFallback,
  removedFallback,
  routeAfter,
  slotTitle,
  withConnection,
} from '../src/api/route-edit.js';

const connections: ConnectionRow[] = [
  { id: 'max', provider: 'anthropic', label: 'Claude key', model: 'claude-opus-4-6' },
  { id: 'or', provider: 'openrouter', label: 'OpenRouter', model: 'openai/gpt-5.2' },
  { id: 'gpt', provider: 'codex', label: 'ChatGPT', model: 'gpt-6-astra' },
].flatMap((raw) => toConnection(raw) ?? []);

const route: ModelRoute = {
  primary: { connection: 'max', model: 'claude-opus-4-6' },
  fallbacks: [
    { connection: 'or', model: 'anthropic/claude-sonnet-4.6' },
    { connection: 'gpt', model: 'gpt-6-astra' },
  ],
};

const name = (connection: string, model: string): string => `${connection}/${model === '' ? 'default' : model}`;

describe('the route editor starts from what the slot holds', () => {
  test('the primary starts on its step, a fallback on its own pair, a new one and an empty route on nothing', () => {
    expect(draftOf(route, { kind: 'primary' })).toEqual({ connection: 'max', model: 'claude-opus-4-6' });
    expect(draftOf(route, { kind: 'fallback', at: 0 })).toEqual({ connection: 'or', model: 'anthropic/claude-sonnet-4.6' });
    expect(draftOf(route, { kind: 'new' })).toEqual({ connection: '', model: '' });
    expect(draftOf(null, { kind: 'primary' })).toEqual({ connection: '', model: '' });
    expect(slotTitle({ kind: 'fallback', at: 1 })).toBe('Fallback 2');
  });

  test('picking a connection takes its default model', () => {
    expect(withConnection(connections, 'gpt')).toEqual({ connection: 'gpt', model: 'gpt-6-astra' });
    expect(withConnection(connections, 'local:session')).toEqual({ connection: 'local:session', model: '' });
  });
});

describe('what the footer says will change', () => {
  test('nothing changed says nothing, a new model on the same connection is one line', () => {
    expect(changesOf(route, connections, { kind: 'primary' }, draftOf(route, { kind: 'primary' }), name)).toEqual([]);
    expect(changesOf(route, connections, { kind: 'primary' }, { connection: 'max', model: 'claude-sonnet-4-6' }, name)).toEqual([
      { label: 'Model', from: 'max/claude-opus-4-6', to: 'max/claude-sonnet-4-6' },
    ]);
  });

  test('another connection gets its own line, and a first primary starts from none', () => {
    expect(changesOf(route, connections, { kind: 'fallback', at: 1 }, { connection: 'or', model: 'x/y' }, name).map((c) => c.label)).toEqual(['Connection', 'Model']);
    expect(changesOf(null, connections, { kind: 'primary' }, { connection: 'or', model: 'x/y' }, name)).toEqual([
      { label: 'Connection', from: 'none', to: 'OpenRouter' },
      { label: 'Model', from: 'none', to: 'or/x/y' },
    ]);
  });

  test('a new fallback is one line once a model is picked', () => {
    expect(changesOf(route, connections, { kind: 'new' }, { connection: 'gpt', model: '' }, name)).toEqual([]);
    expect(changesOf(route, connections, { kind: 'new' }, { connection: 'gpt', model: 'gpt-6-luna' }, name)).toEqual([
      { label: 'New fallback', from: '', to: 'gpt/gpt-6-luna on ChatGPT' },
    ]);
  });
});

describe('what keeps Save off', () => {
  test('a connection is needed, and a fallback needs a named model', () => {
    expect(problemOf(route, connections, { kind: 'new' }, { connection: '', model: '' })).toBe('Choose a connection.');
    expect(problemOf(route, connections, { kind: 'new' }, { connection: 'max', model: '' })).toBe('Choose a named model for a fallback.');
    expect(problemOf(route, connections, { kind: 'primary' }, { connection: 'max', model: '' })).toBe('Choose a model.');
    expect(problemOf(route, connections, { kind: 'primary' }, { connection: 'or', model: '' })).toBe('Choose a model.');
    const local = [...connections, ...localConnections([])];
    expect(problemOf(route, local, { kind: 'primary' }, { connection: 'local:session', model: '' })).toBeNull();
  });

  test('with zero data retention on, a listed model without such an endpoint is refused', () => {
    const zdr = connections.map((c) => (c.id === 'or' ? { ...c, zdr: true } : c));
    const models = [{ id: 'openai/gpt-5.2', name: 'GPT', price: '', zdr: false }, { id: 'anthropic/claude-sonnet-4.6', name: 'Sonnet', price: '', zdr: true }];
    expect(problemOf(route, zdr, { kind: 'fallback', at: 0 }, { connection: 'or', model: 'openai/gpt-5.2' }, models)).toMatch(/no zero data retention endpoint/);
    expect(problemOf(route, zdr, { kind: 'fallback', at: 0 }, { connection: 'or', model: 'anthropic/claude-sonnet-4.6' }, models)).toBeNull();
    expect(problemOf(route, zdr, { kind: 'fallback', at: 0 }, { connection: 'or', model: 'typed/model' }, models)).toBeNull();
    expect(problemOf(route, connections, { kind: 'fallback', at: 0 }, { connection: 'or', model: 'openai/gpt-5.2' }, models)).toBeNull();
  });

  test('a fallback already on the list, or the primary itself, is refused', () => {
    expect(problemOf(route, connections, { kind: 'new' }, { connection: 'gpt', model: 'gpt-6-astra' })).toBe('This model is already in the list.');
    expect(problemOf(route, connections, { kind: 'new' }, { connection: 'max', model: 'claude-opus-4-6' })).toBe('This model is already in the list.');
    expect(problemOf(route, connections, { kind: 'fallback', at: 1 }, { connection: 'gpt', model: 'gpt-6-astra' })).toBeNull();
  });
});

describe('the route after an edit', () => {
  test('a new fallback goes last, an edited one keeps its place, a primary keeps the fallbacks', () => {
    const pick = { connection: 'max', model: 'claude-sonnet-4-6' };
    expect(routeAfter(route, { kind: 'new' }, pick).fallbacks.at(-1)).toEqual(pick);
    expect(routeAfter(route, { kind: 'fallback', at: 0 }, pick).fallbacks[0]).toEqual(pick);
    expect(routeAfter(route, { kind: 'primary' }, pick)).toEqual({ primary: pick, fallbacks: route.fallbacks });
    expect(routeAfter(null, { kind: 'primary' }, pick)).toEqual({ primary: pick, fallbacks: [] });
  });

  test('moving stops at both ends, and removing drops one', () => {
    expect(movedFallback(route, 1, -1).fallbacks.map((f) => f.connection)).toEqual(['gpt', 'or']);
    expect(movedFallback(route, 0, -1)).toEqual(route);
    expect(removedFallback(route, 0).fallbacks).toEqual([{ connection: 'gpt', model: 'gpt-6-astra' }]);
  });

  test('making a fallback primary puts the old primary in its place, unless it has no named model', () => {
    expect(promotedFallback(route, 1)).toEqual({
      primary: { connection: 'gpt', model: 'gpt-6-astra' },
      fallbacks: [{ connection: 'or', model: 'anthropic/claude-sonnet-4.6' }, { connection: 'max', model: 'claude-opus-4-6' }],
    });
    const blank = { ...route, primary: { connection: 'max', model: '' } };
    expect(promotedFallback(blank, 0).fallbacks).toEqual([{ connection: 'gpt', model: 'gpt-6-astra' }]);
    expect(promotedFallback(route, 5)).toEqual(route);
  });

  test('a fallback can be added only under a primary and below the limit', () => {
    expect(canAddFallback(route)).toBe(true);
    expect(canAddFallback(null)).toBe(false);
    const full = { ...route, fallbacks: Array.from({ length: FALLBACKS_MAX }, (_, at) => ({ connection: 'or', model: `m${String(at)}` })) };
    expect(canAddFallback(full)).toBe(false);
  });
});
