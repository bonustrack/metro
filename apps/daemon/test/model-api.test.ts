import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setupOf } from '@metro-labs/inference/delivered';
import { handleModelRequest, type ModelApiDeps } from '../src/gateway/model-api.ts';
import type { OrgModels } from '../src/gateway/org-models.ts';
import { auth } from './identity-helper.ts';
import { deliveredRow, delivery, enrolledKey, fakeApi, keyCredential, orgModelsFor, type FakeApi } from './org-models-fixture.ts';

const OWNER = '0xef8305e140ac520225daf050e2f71d5fbcc543e7';
const CLAUDE_TOKEN = `sk-ant-oat01-${'f'.repeat(80)}`;
const key = enrolledKey();

let server: Server;
let api: FakeApi;
let models: OrgModels;
let base = '';
let deps: ModelApiDeps = {};

beforeAll(async () => {
  api = await fakeApi(key);
  server = createServer((req, res) => {
    if (!handleModelRequest(req, res, deps)) res.writeHead(404).end();
  });
  await new Promise<void>((r) => {
    server.listen(0, '127.0.0.1', r);
  });
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

afterAll(async () => {
  await api.close();
  server.close();
});

beforeEach(() => {
  api.asked.length = 0;
  api.answer = null;
  api.delivery = delivery({ connection: 'or000000001', model: 'openai/gpt-5.2' }, [
    deliveredRow('or000000001', 'openrouter', { label: 'OpenRouter', zdr: true, credential: keyCredential('sk-or-secret') }),
    deliveredRow('cx000000001', 'codex', { label: 'Codex', account: { email: 'l@x', plan: 'pro', method: 'code' }, credential: { accessToken: 'at-secret', expiresAt: 1, method: 'code', accountId: 'acct' } }),
    deliveredRow('an000000001', 'anthropic', { label: 'Max plan', credential: { claudeToken: CLAUDE_TOKEN } }),
  ], [{ connection: 'an000000001', model: 'claude-opus-5' }, { connection: 'cx000000001', model: 'gpt-5.4' }], 'agent');
  models = orgModelsFor(api, key);
  deps = {
    setup: () => setupOf(models.current()),
    sync: () => models.requested(),
    syncStatus: () => models.syncStatus(),
  };
});

const call = async (method: string, path = '/api/model', role: 'admin' | 'member' | null = 'member'): Promise<Response> =>
  fetch(`${base}${path}`, { method, headers: role === null ? {} : { authorization: await auth(OWNER, role) } });

interface Shown {
  source: string | null;
  sync: { enrolled: boolean; at: string | null; error: string | null };
  route: string;
  model: string;
  ready: boolean;
  reason: string | null;
  connections: Record<string, unknown>[];
  fallbacks: { connection: string; model: string }[];
  chain: { connection: string; model: string; active: boolean; hold?: { reason: string } | null }[];
  helpers: { route: string; model: string; fallbacks: unknown[]; chain: { connection: string; model: string; active: boolean }[] } | null;
  effort: { main: string; helpers: string };
}

const shown = async (path = '/api/model'): Promise<Shown> => (await (await call('GET', path)).json()) as Shown;

describe('the Gateway page reads what the organization delivered', () => {
  test('a sync from the page fetches the setup at once and answers the effective route with no secret', async () => {
    const before = await shown('/api/model/snapshot');
    expect(before).toMatchObject({ source: null, route: '', ready: false, reason: "No model is set up for this agent yet: choose one on the organization's Gateway page.", connections: [], chain: [] });
    expect(before).not.toHaveProperty('claude');
    const res = await call('POST', '/api/model/sync');
    expect(res.status).toBe(200);
    const after = (await res.json()) as Shown;
    expect(api.asked.map((a) => a.path)).toEqual(['/api/agents/models']);
    expect(after).toMatchObject({ source: 'agent', route: 'or000000001', model: 'openai/gpt-5.2', ready: true, reason: null, sync: { enrolled: true, error: null } });
    expect(after.connections).toEqual([
      { id: 'or000000001', provider: 'openrouter', label: 'OpenRouter', model: '', hasKey: true, subscription: false, region: '', zdr: true, signedOut: false, account: null, plan: null, method: null },
      { id: 'cx000000001', provider: 'codex', label: 'Codex', model: '', hasKey: false, subscription: false, region: '', zdr: false, signedOut: false, account: 'l@x', plan: 'pro', method: 'code' },
      { id: 'an000000001', provider: 'anthropic', label: 'Max plan', model: '', hasKey: false, subscription: true, region: '', zdr: false, signedOut: false, account: null, plan: null, method: null },
    ]);
    expect(after.fallbacks).toEqual([{ connection: 'an000000001', model: 'claude-opus-5' }, { connection: 'cx000000001', model: 'gpt-5.4' }]);
    expect(after.chain.map((r) => [r.connection, r.model, r.active])).toEqual([
      ['or000000001', 'openai/gpt-5.2', true],
      ['an000000001', 'claude-opus-5', false],
      ['cx000000001', 'gpt-5.4', false],
    ]);
    for (const secret of ['sk-or-secret', 'at-secret', 'acct', CLAUDE_TOKEN]) expect(JSON.stringify(after)).not.toContain(secret);
    expect((await shown('/api/model/snapshot')).route).toBe('or000000001');
  });

  test('the helper models and the effort the organization set are shown, with the defaults for what it left out', async () => {
    await call('POST', '/api/model/sync');
    const plain = await shown('/api/model/snapshot');
    expect(plain.helpers).toBeNull();
    expect(plain.effort).toEqual({ main: 'low', helpers: 'max' });
    const route = api.delivery.route as Record<string, unknown>;
    api.delivery = { ...api.delivery, route: { ...route, helpers: { primary: { connection: 'an000000001', model: 'claude-opus-5-5' }, fallbacks: [{ connection: 'cx000000001', model: 'gpt-5.4' }] }, effort: { helpers: 'asked', main: 'bogus' } } };
    await models.sync();
    const after = await shown('/api/model/snapshot');
    expect(after.helpers).toMatchObject({ route: 'an000000001', model: 'claude-opus-5-5', fallbacks: [{ connection: 'cx000000001', model: 'gpt-5.4' }] });
    expect(after.helpers?.chain.map((r) => [r.connection, r.model, r.active])).toEqual([['an000000001', 'claude-opus-5-5', true], ['cx000000001', 'gpt-5.4', false]]);
    expect(after.effort).toEqual({ main: 'low', helpers: 'asked' });
    expect(after.route).toBe('or000000001');
  });

  test('with no credential delivered, the chain holds nothing back: only a signed-out account is skipped', async () => {
    api.delivery = delivery({ connection: 'cx000000001', model: 'gpt-6.1' }, [
      deliveredRow('cx000000001', 'codex', { label: 'Codex', auth: 'codex', signedOut: false }),
      deliveredRow('cx000000002', 'codex', { label: 'Codex 2', auth: 'codex', signedOut: true }),
      deliveredRow('an000000001', 'anthropic', { label: 'Max plan', auth: 'subscription', signedOut: false }),
    ], [{ connection: 'cx000000002', model: 'gpt-6.1' }, { connection: 'an000000001', model: 'claude-opus-5' }]);
    await call('POST', '/api/model/sync');
    const { chain } = await shown('/api/model/snapshot');
    expect(chain.map((row) => [row.connection, row.active, row.hold?.reason ?? null])).toEqual([
      ['cx000000001', true, null],
      ['cx000000002', false, "Codex is not signed in: sign in again on the organization's Gateway page."],
      ['an000000001', false, null],
    ]);
  });

  test('the routes of the old Gateway page are gone, and every other method is refused', async () => {
    for (const [method, path] of [
      ['PUT', '/api/model'],
      ['POST', '/api/model/connections'],
      ['PUT', '/api/model/connections/or000000001'],
      ['DELETE', '/api/model/connections/or000000001'],
      ['PUT', '/api/model/fallbacks'],
      ['GET', '/api/model/bundle'],
      ['POST', '/api/model/restore'],
      ['POST', '/api/model/codex/login'],
      ['POST', '/api/model/codex/device'],
      ['GET', '/api/model/codex/models'],
      ['POST', '/api/model/gemini/login'],
      ['POST', '/api/model/openrouter/login'],
      ['GET', '/api/model/openrouter/callback'],
      ['GET', '/api/model/anthropic/models'],
      ['GET', '/api/model/bedrock/models'],
      ['GET', '/api/model/claude-models'],
      ['DELETE', '/api/model/claude/Login123456'],
    ] as const) {
      const res = await call(method, path);
      expect([method, path, res.status]).toEqual([method, path, path === '/api/model' ? 405 : 404]);
    }
    expect((await call('GET', '/api/model', null)).status).toBe(401);
    expect((await call('GET', '/api/model/sync')).status).toBe(405);
    expect((await call('POST', '/api/model/snapshot')).status).toBe(405);
  });
});
