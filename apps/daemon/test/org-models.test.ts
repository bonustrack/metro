import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setupOf, watchModelChanges } from '../src/gateway/effective.ts';
import { primaryRoute } from '../src/gateway/model-config.ts';
import { OrgModels } from '../src/gateway/org-models.ts';
import { writeClaudeLogins } from '../src/gateway/claude-store.ts';
import { deliveredRow, delivery, enrolledKey, fakeApi, keyCredential, metroApi, orgModelsFor, OWNER, type FakeApi } from './org-models-fixture.ts';
import { waitFor } from './wait.ts';

const key = enrolledKey();
let api: FakeApi;
let dir = '';

beforeAll(async () => {
  api = await fakeApi(key);
});

afterAll(async () => {
  await api.close();
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'metro-org-models-'));
  api.asked.length = 0;
  api.answer = null;
  api.imported.clear();
  api.delivery = delivery({ connection: 'or000000001', model: 'openai/gpt-5.2' }, [deliveredRow('or000000001', 'openrouter', { label: 'OpenRouter', zdr: true, credential: keyCredential('sk-or-secret') })]);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const modelFile = (): unknown => JSON.parse(readFileSync(join(dir, 'model.json'), 'utf8'));

describe('the delivered model setup', () => {
  test('nothing is asked and nothing is served while the agent is not enrolled with the box owner', async () => {
    for (const models of [orgModelsFor(api, null, dir), orgModelsFor(api, key, dir, null), orgModelsFor(api, key, dir, 'org_01SOMEONEELSE0000')]) {
      await models.sync();
      expect(models.current()).toBeNull();
      expect(models.syncStatus()).toEqual({ enrolled: false, at: null, error: null });
    }
    expect(api.asked).toHaveLength(0);
  });

  test('is fetched signed, held in memory with its credentials, and never written to disk', async () => {
    const models = orgModelsFor(api, key, dir);
    await models.sync();
    expect(api.asked.map((a) => a.path)).toEqual(['/api/agents/models']);
    const held = models.current();
    expect(held?.route?.primary).toEqual({ connection: 'or000000001', model: 'openai/gpt-5.2' });
    expect(held?.connections[0]).toMatchObject({ id: 'or000000001', provider: 'openrouter', apiKey: 'sk-or-secret', zdr: true, revision: 1, signedOut: false });
    expect(models.syncStatus()).toMatchObject({ enrolled: true, error: null });
    expect(() => readFileSync(join(dir, 'model.json'), 'utf8')).toThrow();
  });

  test('only api.metro.box saying it no longer knows the agent key clears the setup; every other failure keeps the last good copy', async () => {
    const models = orgModelsFor(api, key, dir);
    await models.sync();
    const kept = [
      { status: 503, body: { error: 'down' } },
      'drop' as const,
      { status: 200, body: { route: 'nope', connections: 'nope' } },
      { status: 401, body: { error: 'The clock of this agent is more than five minutes off.' } },
      { status: 401, body: { error: 'This agent is not enrolled with Metro, or its request signature is not valid.' } },
      { status: 429, body: { error: 'This agent sent too many requests.' } },
      { status: 403, body: '<html>Cloudflare</html>' },
      { status: 404, body: { error: 'not found' } },
      { status: 400, body: { error: 'bad' } },
    ];
    for (const answer of kept) {
      api.answer = () => answer;
      await models.sync();
      expect(models.current()?.connections[0]?.apiKey).toBe('sk-or-secret');
      expect(models.syncStatus().error).not.toBeNull();
    }
    api.answer = () => ({ status: 401, body: { error: 'This agent is not enrolled with Metro, or its request signature is not valid.', code: 'agent_key_missing' } });
    await models.sync();
    expect(models.current()).toBeNull();
    expect(models.syncStatus().error).toBe('This agent is not enrolled with Metro, or its request signature is not valid.');
  });

  test('the page asks at most once per window; a call inside it answers what is held, and one trailing fetch follows', async () => {
    const models = new OrgModels({ owner: () => OWNER, key: () => key, api: metroApi(api.base), dir: () => dir, pageSyncMs: 300 });
    const fetches = (): number => api.asked.filter((a) => a.path === '/api/agents/models').length;
    await models.requested();
    expect(fetches()).toBe(1);
    await Promise.all([models.requested(), models.requested(), models.requested()]);
    expect(fetches()).toBe(1);
    await waitFor(() => fetches() === 2);
    expect(fetches()).toBe(2);
    await Bun.sleep(400);
    expect(fetches()).toBe(2);
    models.stop();
  });

  test('a connection delivered without a credential is signed out, and a route with no primary serves nothing', async () => {
    api.delivery = delivery({ connection: 'cx000000001', model: 'gpt-5.4' }, [deliveredRow('cx000000001', 'codex', { account: { email: 'l@x', plan: 'pro', method: 'code' } })]);
    const models = orgModelsFor(api, key, dir);
    await models.sync();
    expect(models.current()?.connections[0]).toMatchObject({ codex: null, signedOut: true, account: { email: 'l@x', plan: 'pro', method: 'code' } });
    api.delivery = { route: { primary: null, fallbacks: [] }, source: 'organization', connections: [] };
    await models.sync();
    expect(primaryRoute(setupOf(models.current(), []))).toBeNull();
  });

  test('a renewed Codex sign-in is asked once with the revision used, and replaces the held connection', async () => {
    const codex = (token: string, revision: number): Record<string, unknown> =>
      deliveredRow('cx000000001', 'codex', { revision, model: 'gpt-5.4', credential: { accessToken: token, expiresAt: 1, method: 'chatgpt', accountId: null } });
    api.delivery = delivery({ connection: 'cx000000001', model: 'gpt-5.4' }, [codex('at-old', 3)]);
    api.answer = (path) => (path === '/api/agents/models/refresh' ? { status: 200, body: codex('at-new', 4) } : null);
    const models = orgModelsFor(api, key, dir);
    await models.sync();
    const held = models.current()?.connections[0];
    if (held === undefined) throw new Error('nothing delivered');
    const [one, two] = await Promise.all([models.refresh(held), models.refresh(held)]);
    expect(one?.codex?.accessToken).toBe('at-new');
    expect(two?.revision).toBe(4);
    expect(api.asked.filter((a) => a.path === '/api/agents/models/refresh').map((a) => a.body)).toEqual([{ connection: 'cx000000001', revision: 3 }]);
    expect(models.current()?.connections[0]?.codex?.accessToken).toBe('at-new');
    expect((await models.refresh(held))?.revision).toBe(4);
    api.answer = () => ({ status: 404, body: { error: 'not in the route' } });
    expect(await models.refresh({ ...held, id: 'cx000000002' })).toBeNull();
    const asked = api.asked.length;
    expect(await models.refresh({ ...held, id: 'oldCodex001', revision: 0 })).toBeNull();
    expect(api.asked).toHaveLength(asked);
  });
});

describe('the live switch', () => {
  test('a new primary model goes to the running session once; the same model sends nothing', async () => {
    const models = orgModelsFor(api, key, dir);
    const told: (string | null)[] = [];
    watchModelChanges(models, (model) => {
      told.push(model);
      return true;
    }, () => setupOf(models.current(), []));
    await models.sync();
    await models.sync();
    api.delivery = delivery({ connection: 'or000000001', model: 'anthropic/claude-sonnet-5' }, [deliveredRow('or000000001', 'openrouter', { credential: keyCredential('sk-or-secret') })]);
    await models.sync();
    api.delivery = delivery({ connection: 'or000000001', model: 'anthropic/claude-sonnet-5' }, [deliveredRow('or000000001', 'openrouter', { label: 'Renamed', credential: keyCredential('sk-or-other') })]);
    await models.sync();
    api.answer = () => ({ status: 401, body: { error: 'gone', code: 'agent_key_missing' } });
    await models.sync();
    expect(told).toEqual(['openrouter:openai/gpt-5.2', 'openrouter:anthropic/claude-sonnet-5', null]);
  });
});

const V2 = {
  version: 2,
  route: 'old-login',
  connections: [
    { id: 'old-or', provider: 'openrouter', label: 'OpenRouter', model: 'openai/gpt-5.2', apiKey: 'sk-or-v2', region: '', zdr: true },
    { id: 'old-cx', provider: 'codex', label: 'Codex', model: 'gpt-5.4', codex: { clientId: 'oaiapp_1', subject: 'u1', email: 'l@x', accessToken: 'at', refreshToken: 'rt', expiresAt: 5, savedAt: 'x' } },
    { id: 'old-login', provider: 'anthropic', label: 'Max', model: 'claude-opus-5', claude: { id: 'Login123456', email: 'less@example.com', plan: 'max', savedAt: '2026-10-01T00:00:00.000Z' } },
    { id: 'old-session', provider: 'anthropic', label: 'Anthropic', model: '' },
    { id: 'old-gem', provider: 'gemini', label: 'Gemini', model: 'gemini-3', gemini: { accessToken: 'g' } },
  ],
  fallbacks: [
    { connection: 'old-or', model: 'openai/gpt-5.2' },
    { connection: 'old-gem', model: 'gemini-3' },
    { connection: 'old-session', model: 'claude-sonnet-5' },
  ],
};

describe('the one-time move of model.json to the organization', () => {
  test('without an enrolled key the v2 file stays as it is, and only its Claude logins are seen', async () => {
    writeFileSync(join(dir, 'model.json'), JSON.stringify(V2));
    await orgModelsFor(api, null, dir).sync();
    expect(modelFile()).toEqual(V2);
    const { readClaudeLogins } = await import('../src/gateway/claude-store.ts');
    expect(readClaudeLogins(dir).map((l) => l.id)).toEqual(['Login123456']);
  });

  test('an enrolled agent sends its keys, sign-ins and route once, then keeps only its Claude logins in a v3 file', async () => {
    writeFileSync(join(dir, 'model.json'), JSON.stringify(V2));
    const models = orgModelsFor(api, key, dir);
    await models.sync();
    const sent = api.asked.find((a) => a.path === '/api/agents/models/import')?.body;
    expect(sent).toEqual({
      connections: [
        { id: 'old-or', provider: 'openrouter', label: 'OpenRouter', model: 'openai/gpt-5.2', region: '', zdr: true, apiKey: 'sk-or-v2' },
        { id: 'old-cx', provider: 'codex', label: 'Codex', model: 'gpt-5.4', region: '', zdr: false, codex: { method: 'chatgpt', clientId: 'oaiapp_1', subject: 'u1', email: 'l@x', accessToken: 'at', refreshToken: 'rt', expiresAt: 5, savedAt: 'x' } },
        { id: 'old-login', provider: 'anthropic', label: 'Max', model: 'claude-opus-5', region: '', zdr: false, claude: { id: 'Login123456' } },
        { id: 'old-session', provider: 'anthropic', label: 'Anthropic', model: '', region: '', zdr: false },
      ],
      route: { connection: 'old-login', model: 'claude-opus-5' },
      fallbacks: [
        { connection: 'old-or', model: 'openai/gpt-5.2' },
        { connection: 'old-session', model: 'claude-sonnet-5' },
      ],
    });
    expect(JSON.stringify(sent)).not.toContain('gemini');
    expect(api.asked.map((a) => a.path)).toEqual(['/api/agents/models/import', '/api/agents/models']);
    expect(modelFile()).toEqual({ version: 3, claude: [{ id: 'Login123456', email: 'less@example.com', plan: 'max', savedAt: '2026-10-01T00:00:00.000Z' }] });
    expect(statSync(join(dir, 'model.json')).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(dir, 'model.json'), 'utf8')).not.toContain('sk-or-v2');
    await models.sync();
    expect(api.asked.filter((a) => a.path === '/api/agents/models/import')).toHaveLength(1);
  });

  test('a refused or lost import leaves the v2 file untouched and is sent again; the same ids come back', async () => {
    writeFileSync(join(dir, 'model.json'), JSON.stringify(V2));
    const models = orgModelsFor(api, key, dir);
    api.answer = (path) => (path === '/api/agents/models/import' ? 'drop' : null);
    await models.sync();
    expect(modelFile()).toEqual(V2);
    expect(models.current()?.route?.primary?.connection).toBe('or000000001');
    api.answer = null;
    await models.sync();
    expect(api.asked.filter((a) => a.path === '/api/agents/models/import')).toHaveLength(2);
    expect(modelFile()).toMatchObject({ version: 3 });
    expect([...api.imported.keys()]).toEqual(['old-or', 'old-cx']);
  });

  test('a Claude login saved or removed while the import is on its way is what the v3 file keeps', async () => {
    writeFileSync(join(dir, 'model.json'), JSON.stringify(V2));
    const added = { id: 'Login999999', email: 'new@example.com', plan: 'pro', savedAt: '2026-10-15T00:00:00.000Z' };
    api.answer = (path) => {
      if (path === '/api/agents/models/import') writeClaudeLogins([added], dir);
      return null;
    };
    await orgModelsFor(api, key, dir).sync();
    expect(modelFile()).toEqual({ version: 3, claude: [added] });
  });

  test('the v2 file is served and kept until the setup after the import is delivered', async () => {
    writeFileSync(join(dir, 'model.json'), JSON.stringify(V2));
    const { effectiveSetup } = await import('../src/gateway/effective.ts');
    const models = orgModelsFor(api, key, dir);
    api.answer = (path) => (path === '/api/agents/models' ? { status: 503, body: { error: 'down' } } : null);
    await models.sync();
    expect(modelFile()).toEqual(V2);
    const local = effectiveSetup(dir, models.current());
    expect(local).toMatchObject({ primary: { connection: 'local:Login123456', model: 'claude-opus-5' }, source: null });
    expect(local.fallbacks).toEqual([{ connection: 'old-or', model: 'openai/gpt-5.2' }, { connection: 'local:session', model: 'claude-sonnet-5' }]);
    expect(local.connections.find((c) => c.id === 'old-or')).toMatchObject({ apiKey: 'sk-or-v2', revision: 0 });
    expect(local.connections.find((c) => c.id === 'old-cx')?.codex).toEqual({ method: 'chatgpt', accessToken: 'at', expiresAt: 5, accountId: null });
    expect(local.connections.map((c) => c.id)).not.toContain('old-gem');
    api.answer = null;
    await models.sync();
    expect(modelFile()).toMatchObject({ version: 3 });
    expect(effectiveSetup(dir, models.current()).primary).toEqual({ connection: 'or000000001', model: 'openai/gpt-5.2' });
  });

  test('a connection holding an API key and a Claude login moves as a key connection', async () => {
    const both = { id: 'old-both', provider: 'anthropic', label: 'Both', model: 'claude-opus-5', apiKey: 'sk-ant-both', claude: { id: 'Login123456', email: 'less@example.com', plan: 'max', savedAt: 'x' } };
    writeFileSync(join(dir, 'model.json'), JSON.stringify({ version: 2, route: 'old-both', connections: [both] }));
    const { effectiveSetup } = await import('../src/gateway/effective.ts');
    expect(effectiveSetup(dir, null).connections).toEqual([expect.objectContaining({ id: 'old-both', apiKey: 'sk-ant-both', claude: null })]);
    api.answer = (path) => (path === '/api/agents/models/import' ? { status: 200, body: { ids: { 'old-both': 'new00000000' }, skipped: [{ id: 'x', reason: 'it has no 11-character id' }] } } : null);
    await orgModelsFor(api, key, dir).sync();
    expect(api.asked.find((a) => a.path === '/api/agents/models/import')?.body.connections).toEqual([{ id: 'old-both', provider: 'anthropic', label: 'Both', model: 'claude-opus-5', region: '', zdr: false, apiKey: 'sk-ant-both' }]);
    expect(modelFile()).toEqual({ version: 3, claude: [both.claude] });
  });

  test('a box that only rode the session login sends nothing and pins no override', async () => {
    writeFileSync(join(dir, 'model.json'), JSON.stringify({ version: 2, route: 'k', connections: [{ id: 'k', provider: 'anthropic', model: '' }] }));
    await orgModelsFor(api, key, dir).sync();
    expect(api.asked.map((a) => a.path)).toEqual(['/api/agents/models']);
    expect(modelFile()).toEqual({ version: 3, claude: [] });
  });
});
