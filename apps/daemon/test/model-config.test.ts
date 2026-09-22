import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  addConnection,
  ModelConfigError,
  notReady,
  parseModelConfig,
  publicModelConfig,
  readModelConfig,
  removeConnection,
  resolveRoute,
  routeLabel,
  setRoute,
  updateConnection,
  writeModelConfig,
  type ModelConfig,
} from '../src/gateway/model-config.ts';
import { conn, configOf, connectionId, makeConnection, use } from './model-fixture.ts';

const dirs: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'metro-model-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const CODEX_TOKENS = { accessToken: 'at', refreshToken: 'rt', idToken: '', accountId: 'acct', email: 'l@x', plan: 'pro', savedAt: '2026-09-07T00:00:00.000Z' };
const GEMINI_TOKENS = { accessToken: 'gat', refreshToken: 'grt', expiresAt: 1_800_000_000_000, email: 'l@gmail.com', project: 'proj', tier: 'Google AI Pro', savedAt: '2026-09-20T00:00:00.000Z' };

const configured = (): ModelConfig =>
  configOf('bedrock', [
    makeConnection('bedrock', { region: 'eu-central-1', apiKey: 'aws-key' }),
    makeConnection('openrouter', { apiKey: 'or-key', model: 'openai/gpt-5.2-codex' }),
    makeConnection('codex', { model: 'gpt-5.3-codex', codex: CODEX_TOKENS }),
    makeConnection('gemini', { model: 'gemini-3-pro-preview', gemini: GEMINI_TOKENS }),
  ]);

describe('the connections on disk', () => {
  test('a missing file means no connection at all; a bad file never throws', () => {
    const dir = scratch();
    expect(readModelConfig(dir)).toEqual({ version: 2, route: '', connections: [] });
    writeFileSync(join(dir, 'model.json'), '{"connections":[{"provider":"mars"},7]}');
    expect(readModelConfig(dir)).toEqual({ version: 2, route: '', connections: [] });
  });

  test('written 0600, read back whole, and the public view carries no key', () => {
    const dir = scratch();
    const cfg = configured();
    writeModelConfig(cfg, dir);
    expect(statSync(join(dir, 'model.json')).mode & 0o777).toBe(0o600);
    expect(readModelConfig(dir)).toEqual(cfg);
    const shown = publicModelConfig(cfg);
    expect(JSON.stringify(shown)).not.toContain('aws-key');
    expect(JSON.stringify(shown)).not.toContain('or-key');
    expect(JSON.stringify(shown)).not.toContain('"at"');
    expect(shown).toMatchObject({ route: connectionId('bedrock'), ready: true, reason: null });
    const rows = shown.connections as Record<string, unknown>[];
    expect(rows[0]).toMatchObject({ provider: 'bedrock', region: 'eu-central-1', hasKey: true });
    expect(rows[2]).toMatchObject({ provider: 'codex', signedIn: true, account: 'l@x', plan: 'pro' });
    expect(readFileSync(join(dir, 'model.json'), 'utf8')).toContain('aws-key');
  });

  test('a file written before connections existed becomes one connection per configured provider, keeping the route', () => {
    const old = {
      version: 1,
      provider: 'openrouter',
      anthropic: { apiKey: '', model: '' },
      bedrock: { region: 'eu-central-1', apiKey: 'aws-key', model: '' },
      openrouter: { apiKey: 'or-key', model: 'x/y', zdr: true },
      codex: { model: 'gpt-5.4', auth: CODEX_TOKENS },
      gemini: { model: '', auth: null },
    };
    const cfg = parseModelConfig(old);
    expect(cfg.version).toBe(2);
    expect(cfg.connections.map((c) => c.provider)).toEqual(['bedrock', 'openrouter', 'codex']);
    expect(cfg.connections.map((c) => c.label)).toEqual(['Amazon Bedrock', 'OpenRouter', 'Codex (ChatGPT)']);
    expect(conn(cfg, 'openrouter')).toMatchObject({ apiKey: 'or-key', model: 'x/y', zdr: true });
    expect(conn(cfg, 'codex').codex).toEqual(CODEX_TOKENS);
    expect(cfg.route).toBe(conn(cfg, 'openrouter').id);
    expect(parseModelConfig({ version: 1, provider: 'anthropic' })).toEqual({ version: 2, route: '', connections: [] });
  });
});

describe('several connections of the same provider', () => {
  test('each one is added with its own label, and the first one becomes the route', () => {
    const one = addConnection({ version: 2, route: '', connections: [] }, { provider: 'openrouter', apiKey: 'k1', model: 'a/b' });
    expect(one.connections[0]?.label).toBe('OpenRouter');
    expect(one.route).toBe(one.connections[0]?.id);
    const two = addConnection(one, { provider: 'openrouter', apiKey: 'k2' });
    expect(two.connections.map((c) => c.label)).toEqual(['OpenRouter', 'OpenRouter 2']);
    expect(two.route).toBe(one.route);
    expect(two.connections[0]?.id).not.toBe(two.connections[1]?.id);
    const named = addConnection(two, { provider: 'openrouter', label: 'Work', apiKey: 'k3' });
    expect(named.connections[2]?.label).toBe('Work');
    expect(() => addConnection(two, { provider: 'mars' })).toThrow(ModelConfigError);
  });

  test('a patch names one connection, an unknown id is refused, and removing the routed one moves the route', () => {
    const cfg = configured();
    const id = conn(cfg, 'openrouter').id;
    const next = updateConnection(cfg, id, { model: 'anthropic/claude-sonnet-4.5', zdr: true });
    expect(next.connections.find((c) => c.id === id)).toMatchObject({ apiKey: 'or-key', model: 'anthropic/claude-sonnet-4.5', zdr: true });
    expect(next.connections.find((c) => c.provider === 'bedrock')).toEqual(conn(cfg, 'bedrock'));
    expect(updateConnection(cfg, id, { apiKey: '' }).connections.find((c) => c.id === id)?.apiKey).toBe('');
    expect(() => updateConnection(cfg, 'cn-nope', { model: 'x' })).toThrow(/no such connection/);
    expect(() => updateConnection(cfg, id, { zdr: 'yes' })).toThrow(/true or false/);
    expect(() => updateConnection(cfg, id, { apiKey: 'x'.repeat(600) })).toThrow(/too long/);
    const dropped = removeConnection(cfg, cfg.route);
    expect(dropped.connections.map((c) => c.provider)).toEqual(['openrouter', 'codex', 'gemini']);
    expect(dropped.route).toBe(id);
    expect(() => setRoute(cfg, 'cn-nope')).toThrow(/no such connection/);
    expect(setRoute(cfg, id).route).toBe(id);
  });
});

describe('readiness and resolving a request', () => {
  test('readiness names the missing piece of the routed connection', () => {
    const cfg = configured();
    expect(notReady(configOf('anthropic', [makeConnection('anthropic')]))).toBeNull();
    expect(notReady(cfg)).toBeNull();
    expect(notReady(updateConnection(cfg, cfg.route, { apiKey: '' }))).toMatch(/API key/);
    expect(notReady(updateConnection(cfg, cfg.route, { region: '' }))).toMatch(/region/);
    const or = setRoute(cfg, conn(cfg, 'openrouter').id);
    expect(notReady(updateConnection(or, or.route, { model: '' }))).toMatch(/model id/);
    expect(notReady({ version: 2, route: '', connections: [] })).toBeNull();
    expect(notReady({ ...cfg, route: '' })).toMatch(/Claude Code login/);
  });

  test('a plain id goes to the routed connection, a prefix picks that provider for the request', () => {
    const cfg = configured();
    expect(resolveRoute('claude-sonnet-4-6', cfg)).toMatchObject({ model: 'claude-sonnet-4-6' });
    expect(resolveRoute('claude-sonnet-4-6', cfg)?.connection.provider).toBe('bedrock');
    expect(resolveRoute('openrouter:google/gemini-2.5-pro', cfg)?.connection.provider).toBe('openrouter');
    expect(resolveRoute('openrouter:google/gemini-2.5-pro', cfg)?.model).toBe('google/gemini-2.5-pro');
    expect(resolveRoute('mars:x', cfg)?.model).toBe('mars:x');
    expect(resolveRoute('anthropic:claude-opus-4-8', cfg)).toBeNull();
    expect(resolveRoute('x', { version: 2, route: '', connections: [] })).toBeNull();
  });

  test('a prefix takes the connection already in use for that provider, else its first one', () => {
    const cfg = configOf('openrouter', [
      makeConnection('openrouter', { apiKey: 'k1', model: 'a/b' }),
      { ...makeConnection('openrouter', { apiKey: 'k2', model: 'c/d' }), id: 'cn-or-2', label: 'Work' },
    ]);
    expect(resolveRoute('openrouter:x/y', cfg)?.connection.id).toBe(connectionId('openrouter'));
    const second = setRoute(cfg, 'cn-or-2');
    expect(resolveRoute('openrouter:x/y', second)?.connection.id).toBe('cn-or-2');
    expect(resolveRoute('claude-sonnet-5', second)?.model).toBe('c/d');
  });

  test('a pinned model replaces what Claude Code asked for, and a matching id passes', () => {
    const cfg = configured();
    const pinned = updateConnection(cfg, cfg.route, { model: 'eu.anthropic.claude-sonnet-4-6' });
    expect(resolveRoute('claude-opus-5', pinned)?.model).toBe('eu.anthropic.claude-sonnet-4-6');
    use(cfg, 'codex');
    expect(resolveRoute('claude-sonnet-5', cfg)?.model).toBe('gpt-5.3-codex');
    expect(resolveRoute('gpt-5.4', cfg)?.model).toBe('gpt-5.4');
    use(cfg, 'gemini');
    expect(resolveRoute('claude-sonnet-5', cfg)?.model).toBe('gemini-3-pro-preview');
    expect(resolveRoute('gemini-3-flash', cfg)?.model).toBe('gemini-3-flash');
    const anthropic = configOf('anthropic', [makeConnection('anthropic', { apiKey: 'sk', model: 'claude-opus-5' })]);
    expect(resolveRoute('claude-haiku-4-5-20251001', anthropic)?.model).toBe('claude-haiku-4-5-20251001');
    expect(resolveRoute('claude-sonnet-5', anthropic)?.model).toBe('claude-opus-5');
    expect(routeLabel({ connection: makeConnection('anthropic'), model: 'claude-sonnet-5' })).toBe('claude-sonnet-5');
    expect(routeLabel({ connection: makeConnection('openrouter'), model: 'x/y' })).toBe('openrouter:x/y');
  });
});
