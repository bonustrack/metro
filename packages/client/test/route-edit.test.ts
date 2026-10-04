import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { clearAccount } from '../src/auth/account.js';
import { installTestAccount } from './account-fixture.js';
import { toModelSettings, type ModelSettings } from '../src/api/model.js';
import {
  changesOf,
  draftOf,
  fallbacksAfter,
  movedFallbacks,
  problemOf,
  promoteFallback,
  promotedFallbacks,
  saveRoute,
  sameRoute,
  sharesConnection,
  slotTitle,
  withConnection,
} from '../src/api/route-edit.js';

beforeAll(() => {
  installTestAccount();
});

afterAll(() => {
  clearAccount();
});

const settings: ModelSettings = toModelSettings({
  route: 'max',
  connections: [
    { id: 'max', provider: 'anthropic', label: 'Claude Max', model: 'claude-opus-4-6', signedIn: true },
    { id: 'or', provider: 'openrouter', label: 'OpenRouter', model: 'openai/gpt-5.2', hasKey: true, zdr: false },
    { id: 'gpt', provider: 'codex', label: 'ChatGPT', model: 'gpt-6-astra', signedIn: true },
  ],
  fallbacks: [
    { connection: 'or', model: 'anthropic/claude-sonnet-4.6' },
    { connection: 'gpt', model: 'gpt-6-astra' },
  ],
  chain: [{ connection: 'max', model: 'claude-opus-4-6', used: 0.4, hold: null, active: true }],
});

const name = (connection: string, model: string): string => `${connection}/${model === '' ? 'default' : model}`;

describe('the route editor starts from what the slot holds', () => {
  test('the primary starts on its connection and model, a fallback on its own pair, a new one on nothing', () => {
    expect(draftOf(settings, { kind: 'primary' })).toEqual({ connection: 'max', model: 'claude-opus-4-6', zdr: false });
    expect(draftOf(settings, { kind: 'fallback', at: 0 })).toEqual({ connection: 'or', model: 'anthropic/claude-sonnet-4.6', zdr: false });
    expect(draftOf(settings, { kind: 'new' })).toEqual({ connection: '', model: '', zdr: false });
    expect(slotTitle({ kind: 'fallback', at: 1 })).toBe('Fallback 2');
  });

  test('picking a connection takes its stored model and its zero data retention setting', () => {
    expect(withConnection(settings, 'gpt')).toEqual({ connection: 'gpt', model: 'gpt-6-astra', zdr: false });
  });
});

describe('what the footer says will change', () => {
  test('nothing changed says nothing, a new model on the same connection is one line', () => {
    expect(changesOf(settings, { kind: 'primary' }, draftOf(settings, { kind: 'primary' }), name)).toEqual([]);
    expect(changesOf(settings, { kind: 'primary' }, { connection: 'max', model: 'claude-sonnet-4-6', zdr: false }, name)).toEqual([
      { label: 'Model', from: 'max/claude-opus-4-6', to: 'max/claude-sonnet-4-6' },
    ]);
  });

  test('another connection and zero data retention each get their own line', () => {
    const changes = changesOf(settings, { kind: 'fallback', at: 1 }, { connection: 'or', model: 'anthropic/claude-sonnet-4.6', zdr: true }, name);
    expect(changes.map((c) => c.label)).toEqual(['Connection', 'Model', 'Zero data retention']);
    expect(changes[2]).toEqual({ label: 'Zero data retention', from: 'off', to: 'on' });
  });

  test('a new fallback is one line once a model is picked', () => {
    expect(changesOf(settings, { kind: 'new' }, { connection: 'gpt', model: '', zdr: false }, name)).toEqual([]);
    expect(changesOf(settings, { kind: 'new' }, { connection: 'gpt', model: 'gpt-6-luna', zdr: false }, name)).toEqual([
      { label: 'New fallback', from: '', to: 'gpt/gpt-6-luna on ChatGPT' },
    ]);
  });
});

describe('what keeps Save off', () => {
  const zdrModels = new Set(['anthropic/claude-sonnet-4.6']);

  test('a connection is needed, and a fallback needs a named model', () => {
    expect(problemOf(settings, { kind: 'new' }, { connection: '', model: '', zdr: false }, null)).toBe('Choose a connection.');
    expect(problemOf(settings, { kind: 'new' }, { connection: 'max', model: '', zdr: false }, null)).toBe('Choose a named model for a fallback.');
    expect(problemOf(settings, { kind: 'primary' }, { connection: 'max', model: '', zdr: false }, null)).toBeNull();
    expect(problemOf(settings, { kind: 'primary' }, { connection: 'or', model: '', zdr: false }, null)).toBe('Choose a model.');
  });

  test('a fallback already on the list, or the primary itself, is refused', () => {
    expect(problemOf(settings, { kind: 'new' }, { connection: 'gpt', model: 'gpt-6-astra', zdr: false }, null)).toBe('This model is already in the list.');
    expect(problemOf(settings, { kind: 'new' }, { connection: 'max', model: 'claude-opus-4-6', zdr: false }, null)).toBe('This model is already in the list.');
    expect(problemOf(settings, { kind: 'fallback', at: 1 }, { connection: 'gpt', model: 'gpt-6-astra', zdr: false }, null)).toBeNull();
  });

  test('with zero data retention on, a model without such an endpoint is refused', () => {
    expect(problemOf(settings, { kind: 'fallback', at: 0 }, { connection: 'or', model: 'openai/gpt-5.2', zdr: true }, zdrModels)).toMatch(/no zero data retention endpoint/);
    expect(problemOf(settings, { kind: 'fallback', at: 0 }, { connection: 'or', model: 'anthropic/claude-sonnet-4.6', zdr: true }, zdrModels)).toBeNull();
    expect(problemOf(settings, { kind: 'fallback', at: 0 }, { connection: 'or', model: 'openai/gpt-5.2', zdr: true }, null)).toBeNull();
  });
});

describe('the fallback list after an edit', () => {
  test('a new one goes last, an edited one keeps its place, the primary leaves the list alone', () => {
    const pick = { connection: 'max', model: 'claude-sonnet-4-6', zdr: false };
    expect(fallbacksAfter(settings, { kind: 'new' }, pick).at(-1)).toEqual({ connection: 'max', model: 'claude-sonnet-4-6' });
    expect(fallbacksAfter(settings, { kind: 'fallback', at: 0 }, pick)[0]).toEqual({ connection: 'max', model: 'claude-sonnet-4-6' });
    expect(fallbacksAfter(settings, { kind: 'primary' }, pick)).toEqual(settings.fallbacks ?? []);
  });

  test('moving stops at both ends', () => {
    const list = settings.fallbacks ?? [];
    expect(movedFallbacks(list, 1, -1).map((f) => f.connection)).toEqual(['gpt', 'or']);
    expect(movedFallbacks(list, 0, -1)).toEqual(list);
  });

  test('making a fallback primary puts the old primary in its place', () => {
    expect(promotedFallbacks(settings, 1)).toEqual([
      { connection: 'or', model: 'anthropic/claude-sonnet-4.6' },
      { connection: 'max', model: 'claude-opus-4-6' },
    ]);
    expect(sameRoute(promotedFallbacks(settings, 0)[0] ?? { connection: '', model: '' }, { connection: 'max', model: 'claude-opus-4-6' })).toBe(true);
  });

  test('zero data retention is shared by every slot on its connection', () => {
    expect(sharesConnection(settings, { kind: 'fallback', at: 0 }, 'or')).toBe(false);
    expect(sharesConnection(settings, { kind: 'new' }, 'or')).toBe(true);
    expect(sharesConnection(settings, { kind: 'fallback', at: 0 }, 'max')).toBe(true);
  });
});

describe('saving talks to the daemon in the right order', () => {
  const realFetch = globalThis.fetch;
  let calls: string[] = [];
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function serve(): void {
    calls = [];
    globalThis.fetch = ((url: string, init?: RequestInit) => {
      const path = new URL(url).pathname.replace(/^.*\/api\/model/, '');
      calls.push(`${init?.method ?? 'GET'} ${path} ${typeof init?.body === 'string' ? init.body : ''}`.trim());
      return Promise.resolve(new Response(JSON.stringify({ route: 'max', connections: [] }), { status: 200, headers: { 'content-type': 'application/json' } }));
    }) as unknown as typeof fetch;
  }

  test('a new primary saves the model on its connection, then routes to it', async () => {
    serve();
    await saveRoute(settings, { kind: 'primary' }, { connection: 'or', model: 'anthropic/claude-sonnet-4.6', zdr: true });
    expect(calls).toEqual(['PUT /connections/or {"model":"anthropic/claude-sonnet-4.6","zdr":true}', 'PUT  {"route":"or"}']);
  });

  test('a fallback saves zero data retention on its connection, then the list', async () => {
    serve();
    await saveRoute(settings, { kind: 'fallback', at: 0 }, { connection: 'or', model: 'anthropic/claude-sonnet-4.6', zdr: true });
    expect(calls).toEqual([
      'PUT /connections/or {"zdr":true}',
      'PUT /fallbacks {"fallbacks":[{"connection":"or","model":"anthropic/claude-sonnet-4.6"},{"connection":"gpt","model":"gpt-6-astra"}]}',
    ]);
  });

  test('making a fallback primary saves the list, its model, then the route', async () => {
    serve();
    await promoteFallback(settings, 1);
    expect(calls).toEqual([
      'PUT /fallbacks {"fallbacks":[{"connection":"or","model":"anthropic/claude-sonnet-4.6"},{"connection":"max","model":"claude-opus-4-6"}]}',
      'PUT /connections/gpt {"model":"gpt-6-astra"}',
      'PUT  {"route":"gpt"}',
    ]);
  });
});
