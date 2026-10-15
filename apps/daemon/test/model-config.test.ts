import { describe, expect, test } from 'bun:test';
import { modelViewText, setupOf as effective } from '../src/gateway/effective.ts';
import { notReady, primaryRoute, resolveRoute, routeLabel, runnerModel, SESSION_LOGIN, type ModelSetup } from '../src/gateway/model-config.ts';
import { codexAccess, conn, connectionId, makeConnection, setupOf, use } from './model-fixture.ts';

const configured = (): ModelSetup =>
  setupOf('bedrock', [
    makeConnection('bedrock', { region: 'eu-central-1', apiKey: 'aws-key' }),
    makeConnection('openrouter', { apiKey: 'or-key', model: 'openai/gpt-5.2-codex' }),
    makeConnection('codex', { model: 'gpt-5.3-codex', codex: codexAccess() }),
  ]);

const LOGIN = { id: 'Xyz12345678', email: 'less@example.com', plan: 'max', savedAt: '2026-10-01T00:00:00.000Z' };

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
    expect(notReady({ connection: makeConnection('anthropic'), model: 'claude-sonnet-5' })).toMatch(/no API key/);
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

describe('local routes of this box', () => {
  test('local:<login> is the Claude login of this box with its account, and a login not on the box is named', () => {
    const setup = effective({ route: { primary: { connection: `local:${LOGIN.id}`, model: 'claude-opus-5' }, fallbacks: [{ connection: 'local:Gone1234567', model: 'claude-sonnet-5' }] }, source: 'agent', connections: [] }, [LOGIN]);
    const primary = primaryRoute(setup);
    expect(primary).toMatchObject({ model: 'claude-opus-5', connection: { id: `local:${LOGIN.id}`, provider: 'anthropic', claude: LOGIN.id, account: { email: LOGIN.email, plan: 'max' }, signedOut: false } });
    expect(primary === null ? 'none' : notReady(primary)).toBeNull();
    const gone = setup.connections.find((c) => c.id === 'local:Gone1234567');
    expect(gone === undefined ? 'none' : notReady({ connection: gone, model: 'x' })).toMatch(/not on this box/);
    expect(setup.source).toBe('agent');
    expect(runnerModel(setup)).toBe('claude-opus-5');
  });

  test('local:session rides the login of the session itself, and no route at all is the same passthrough', () => {
    const setup = effective({ route: { primary: { connection: SESSION_LOGIN, model: '' }, fallbacks: [] }, source: 'organization', connections: [] }, []);
    expect(primaryRoute(setup)?.connection).toMatchObject({ id: SESSION_LOGIN, provider: 'anthropic', apiKey: '', claude: null });
    expect(resolveRoute('claude-sonnet-5', setup)?.model).toBe('claude-sonnet-5');
    expect(runnerModel(setup)).toBeNull();
    expect(effective(null, [LOGIN])).toEqual({ primary: null, fallbacks: [], connections: [], source: null });
    expect(effective({ route: null, source: null, connections: [] }, [])).toMatchObject({ primary: null, connections: [] });
  });

  test('the agent view names the primary connection and the route model, a local one as anthropic, and never a credential', () => {
    const keyed = configured();
    keyed.primary = { connection: connectionId('openrouter'), model: 'x/y' };
    expect(JSON.parse(modelViewText(keyed) ?? '')).toEqual({ version: 2, route: connectionId('openrouter'), connections: [{ id: connectionId('openrouter'), provider: 'openrouter', model: 'x/y' }] });
    expect(modelViewText(keyed)).not.toContain('or-key');
    const local = effective({ route: { primary: { connection: `local:${LOGIN.id}`, model: 'claude-opus-5' }, fallbacks: [] }, source: 'agent', connections: [] }, [LOGIN]);
    expect(JSON.parse(modelViewText(local) ?? '')).toEqual({ version: 2, route: `local:${LOGIN.id}`, connections: [{ id: `local:${LOGIN.id}`, provider: 'anthropic', model: 'claude-opus-5' }] });
    expect(modelViewText({ ...keyed, primary: null })).toBeNull();
  });
});
