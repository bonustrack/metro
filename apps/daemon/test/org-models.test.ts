import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { log } from '@metro-labs/core/log';
import { effectiveSetup, setupOf, watchModelChanges } from '../src/gateway/effective.ts';
import { primaryRoute } from '../src/gateway/model-config.ts';
import { OrgModels } from '../src/gateway/org-models.ts';
import { readClaudeLogins, retireV2ModelFile, writeClaudeLogins } from '../src/gateway/claude-store.ts';
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
  api.delivery = delivery({ connection: 'or000000001', model: 'openai/gpt-5.2' }, [deliveredRow('or000000001', 'openrouter', { label: 'OpenRouter', zdr: true, credential: keyCredential('sk-or-secret') })]);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const modelFile = (): unknown => JSON.parse(readFileSync(join(dir, 'model.json'), 'utf8'));

describe('the delivered model setup', () => {
  test('nothing is asked and nothing is served while the agent is not enrolled with the box owner', async () => {
    for (const models of [orgModelsFor(api, null), orgModelsFor(api, key, null), orgModelsFor(api, key, 'org_01SOMEONEELSE0000')]) {
      await models.sync();
      expect(models.current()).toBeNull();
      expect(models.syncStatus()).toEqual({ enrolled: false, at: null, error: null });
    }
    expect(api.asked).toHaveLength(0);
  });

  test('is fetched signed, held in memory with its credentials, and never written to disk', async () => {
    const models = orgModelsFor(api, key);
    await models.sync();
    expect(api.asked.map((a) => a.path)).toEqual(['/api/agents/models']);
    const held = models.current();
    expect(held?.route?.primary).toEqual({ connection: 'or000000001', model: 'openai/gpt-5.2' });
    expect(held?.connections[0]).toMatchObject({ id: 'or000000001', provider: 'openrouter', apiKey: 'sk-or-secret', zdr: true, revision: 1, signedOut: false });
    expect(models.syncStatus()).toMatchObject({ enrolled: true, error: null });
  });

  test('only api.metro.box saying it no longer knows the agent key clears the setup; every other failure keeps the last good copy', async () => {
    const models = orgModelsFor(api, key);
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
    const models = new OrgModels({ owner: () => OWNER, key: () => key, api: metroApi(api.base), pageSyncMs: 300 });
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
    const models = orgModelsFor(api, key);
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
    const models = orgModelsFor(api, key);
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
  });
});

describe('the live switch', () => {
  test('a new primary model goes to the running session once; the same model sends nothing', async () => {
    const models = orgModelsFor(api, key);
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

const LOGIN = { id: 'Login123456', email: 'less@example.com', plan: 'max', savedAt: '2026-10-01T00:00:00.000Z' };

const V2 = {
  version: 2,
  route: 'old-login',
  connections: [
    { id: 'old-or', provider: 'openrouter', label: 'OpenRouter', model: 'openai/gpt-5.2', apiKey: 'sk-or-v2', region: '', zdr: true },
    { id: 'old-cx', provider: 'codex', label: 'Codex', model: 'gpt-5.4', codex: { clientId: 'oaiapp_1', accessToken: 'at-v2', refreshToken: 'rt-v2', expiresAt: 5 } },
    { id: 'old-login', provider: 'anthropic', label: 'Max', model: 'claude-opus-5', claude: LOGIN },
    { id: 'old-gem', provider: 'gemini', label: 'Gemini', model: 'gemini-3', gemini: { accessToken: 'g' } },
  ],
  fallbacks: [{ connection: 'old-or', model: 'openai/gpt-5.2' }],
};

describe('a model.json still in the old version 2', () => {
  test('is never served: only its Claude logins are seen, and the organization setup is what runs', () => {
    writeFileSync(join(dir, 'model.json'), JSON.stringify(V2));
    expect(readClaudeLogins(dir)).toEqual([LOGIN]);
    expect(effectiveSetup(dir, null)).toEqual({ primary: null, fallbacks: [], connections: [], source: null });
    const delivered = { route: { primary: { connection: 'or000000001', model: 'openai/gpt-5.2' }, fallbacks: [] }, source: 'organization' as const, connections: [] };
    expect(effectiveSetup(dir, delivered).primary).toEqual({ connection: 'or000000001', model: 'openai/gpt-5.2' });
  });

  test('is rewritten at start as version 3 with only its Claude logins, with one warning, and a second start changes nothing', () => {
    writeFileSync(join(dir, 'model.json'), JSON.stringify(V2));
    const warn = spyOn(log, 'warn');
    try {
      expect(retireV2ModelFile(dir)).toBe(true);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(retireV2ModelFile(dir)).toBe(false);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
    expect(modelFile()).toEqual({ version: 3, claude: [LOGIN] });
    expect(statSync(join(dir, 'model.json')).mode & 0o777).toBe(0o600);
    for (const secret of ['sk-or-v2', 'at-v2', 'rt-v2', 'gemini']) expect(readFileSync(join(dir, 'model.json'), 'utf8')).not.toContain(secret);
  });

  test('a version 3 file, a missing one or an unreadable one is left as it is', () => {
    expect(retireV2ModelFile(dir)).toBe(false);
    writeFileSync(join(dir, 'model.json'), JSON.stringify({ version: 3, claude: [LOGIN] }));
    expect(retireV2ModelFile(dir)).toBe(false);
    expect(modelFile()).toEqual({ version: 3, claude: [LOGIN] });
    writeFileSync(join(dir, 'model.json'), '{not json');
    expect(retireV2ModelFile(dir)).toBe(false);
    expect(readFileSync(join(dir, 'model.json'), 'utf8')).toBe('{not json');
  });

  test('a Claude login saved over it writes version 3', () => {
    writeFileSync(join(dir, 'model.json'), JSON.stringify(V2));
    const added = { id: 'Login999999', email: 'new@example.com', plan: 'pro', savedAt: '2026-10-15T00:00:00.000Z' };
    writeClaudeLogins([...readClaudeLogins(dir), added], dir);
    expect(modelFile()).toEqual({ version: 3, claude: [LOGIN, added] });
  });
});
