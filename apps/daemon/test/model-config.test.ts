import { describe, expect, test } from 'bun:test';
import { modelViewText, setupOf as effective } from '../src/gateway/effective.ts';
import { notReady, primaryRoute, resolveRoute, routeLabel, runnerModel, type ModelSetup } from '@metro-labs/inference/model-config';
import { deliveredConnection } from '../src/gateway/delivered.ts';
import { codexAccess, conn, connectionId, makeConnection, setupOf, use } from './model-fixture.ts';

const configured = (): ModelSetup =>
  setupOf('bedrock', [
    makeConnection('bedrock', { region: 'eu-central-1', apiKey: 'aws-key' }),
    makeConnection('openrouter', { apiKey: 'or-key', model: 'openai/gpt-5.2-codex' }),
    makeConnection('codex', { model: 'gpt-5.3-codex', codex: codexAccess() }),
  ]);

const CLAUDE_TOKEN = `sk-ant-oat01-${'b'.repeat(80)}`;

describe('readiness and resolving a request', () => {
  test('readiness names the missing piece of a route', () => {
    const route = (setup: ModelSetup): NonNullable<ReturnType<typeof primaryRoute>> => {
      const found = primaryRoute(setup);
      if (found === null) throw new Error('no route');
      return found;
    };
    expect(notReady(route(configured()))).toBeNull();
    expect(notReady({ connection: makeConnection('bedrock', { region: 'eu-central-1' }), model: 'x' })).toMatch(/API key/);
    expect(notReady({ connection: makeConnection('bedrock', { apiKey: 'k' }), model: 'x' })).toMatch(/region/);
    expect(notReady({ connection: makeConnection('openrouter', { apiKey: 'k' }), model: '' })).toMatch(/model id/);
    expect(notReady({ connection: makeConnection('codex', { model: 'gpt-5.4' }), model: 'gpt-5.4' })).toMatch(/not signed in/);
    expect(notReady({ connection: makeConnection('anthropic'), model: 'claude-sonnet-5' })).toMatch(/no API key or Claude subscription/);
    expect(notReady({ connection: makeConnection('anthropic', { claudeToken: CLAUDE_TOKEN }), model: 'claude-sonnet-5' })).toBeNull();
    expect(primaryRoute({ ...configured(), primary: null })).toBeNull();
    expect(primaryRoute({ ...configured(), primary: { connection: 'cn-gone', model: '' } })).toBeNull();
  });

  test('a plain id goes to the primary, a prefix picks that provider, and a prefix nobody serves falls back to the primary', () => {
    const setup = configured();
    expect(resolveRoute('claude-sonnet-4-6', setup)).toMatchObject({ model: 'claude-sonnet-4-6' });
    expect(resolveRoute('claude-sonnet-4-6', setup)?.connection.provider).toBe('bedrock');
    expect(resolveRoute('openrouter:google/gemini-2.5-pro', setup)?.connection.provider).toBe('openrouter');
    expect(resolveRoute('openrouter:google/gemini-2.5-pro', setup)?.model).toBe('google/gemini-2.5-pro');
    expect(resolveRoute('mars:x', setup)?.model).toBe('mars:x');
    expect(resolveRoute('anthropic:claude-opus-4-8', setup)).toMatchObject({ model: 'claude-opus-4-8', connection: { provider: 'bedrock' } });
    expect(resolveRoute('x', { ...setup, primary: null })).toBeNull();
  });

  test('the model of the route wins over the default model of its connection', () => {
    const setup = configured();
    setup.primary = { connection: connectionId('openrouter'), model: 'anthropic/claude-sonnet-5' };
    expect(resolveRoute('claude-opus-5', setup)?.model).toBe('anthropic/claude-sonnet-5');
    expect(runnerModel(setup)).toBe('openrouter:anthropic/claude-sonnet-5');
  });

  test('a pinned model replaces what Claude Code asked for, and a matching id passes', () => {
    const setup = setupOf('bedrock', [makeConnection('bedrock', { region: 'eu-central-1', apiKey: 'k', model: 'eu.anthropic.claude-sonnet-4-6' }), ...configured().connections.slice(1)]);
    expect(resolveRoute('claude-opus-5', setup)?.model).toBe('eu.anthropic.claude-sonnet-4-6');
    use(setup, 'codex');
    expect(resolveRoute('claude-sonnet-5', setup)?.model).toBe('gpt-5.3-codex');
    expect(resolveRoute('gpt-5.4', setup)?.model).toBe('gpt-5.4');
    const anthropic = setupOf('anthropic', [makeConnection('anthropic', { apiKey: 'sk', model: 'claude-opus-5' })]);
    expect(resolveRoute('claude-haiku-4-5-20251001', anthropic)?.model).toBe('claude-haiku-4-5-20251001');
    expect(resolveRoute('claude-sonnet-5', anthropic)?.model).toBe('claude-opus-5');
    expect(routeLabel({ connection: makeConnection('anthropic'), model: 'claude-sonnet-5' })).toBe('claude-sonnet-5');
    expect(routeLabel({ connection: makeConnection('openrouter'), model: 'x/y' })).toBe('openrouter:x/y');
    expect(conn(setup, 'codex').codex?.method).toBe('chatgpt');
  });
});

describe('the setup the organization delivered', () => {
  test('a Claude subscription arrives as its token, and nothing else turns an Anthropic connection into one', () => {
    const subscribed = deliveredConnection({ id: 'conn0000001', provider: 'anthropic', label: 'Max plan', revision: 2, credential: { claudeToken: CLAUDE_TOKEN } });
    expect(subscribed).toMatchObject({ id: 'conn0000001', provider: 'anthropic', apiKey: '', claudeToken: CLAUDE_TOKEN, signedOut: false });
    expect(deliveredConnection({ id: 'conn0000002', provider: 'anthropic', credential: null })).toMatchObject({ claudeToken: '', signedOut: true });
    expect(deliveredConnection({ id: 'conn0000003', provider: 'openrouter', credential: { claudeToken: CLAUDE_TOKEN } })).toMatchObject({ apiKey: '', claudeToken: '', signedOut: true });
    const setup = effective({ route: { primary: { connection: 'conn0000001', model: 'claude-opus-5' }, fallbacks: [] }, source: 'agent', connections: subscribed === null ? [] : [subscribed] });
    expect(primaryRoute(setup)?.connection.claudeToken).toBe(CLAUDE_TOKEN);
    expect(runnerModel(setup)).toBe('claude-opus-5');
  });

  test('no delivery or no route means no model at all', () => {
    expect(effective(null)).toEqual({ primary: null, fallbacks: [], connections: [], source: null });
    expect(effective({ route: null, source: null, connections: [] })).toMatchObject({ primary: null, connections: [] });
    expect(resolveRoute('claude-sonnet-5', effective(null))).toBeNull();
  });

  test('the agent view names the primary connection and the route model, and never a credential', () => {
    const keyed = configured();
    keyed.primary = { connection: connectionId('openrouter'), model: 'x/y' };
    expect(JSON.parse(modelViewText(keyed) ?? '')).toEqual({ version: 2, route: connectionId('openrouter'), connections: [{ id: connectionId('openrouter'), provider: 'openrouter', model: 'x/y' }] });
    expect(modelViewText(keyed)).not.toContain('or-key');
    const subscribed = setupOf('anthropic', [makeConnection('anthropic', { claudeToken: CLAUDE_TOKEN })]);
    subscribed.primary = { connection: connectionId('anthropic'), model: 'claude-opus-5' };
    expect(modelViewText(subscribed)).not.toContain(CLAUDE_TOKEN);
    expect(modelViewText({ ...keyed, primary: null })).toBeNull();
  });
});
