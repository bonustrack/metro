import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setupOf } from '../src/gateway/effective.ts';
import { handleModelRequest, type ModelApiDeps } from '../src/gateway/model-api.ts';
import { forgetModelLists } from '../src/gateway/model-lists.ts';
import type { OrgModels } from '../src/gateway/org-models.ts';
import { refreshLoginModels } from '../src/gateway/provider-models.ts';
import { forgetUsage, noteUsageHeaders } from '../src/gateway/usage.ts';
import { usageIn } from '../src/claude/usage-probe.ts';
import { recordedClaudeModels } from './claude-models-fixture.ts';
import { auth } from './identity-helper.ts';
import { deliveredRow, delivery, enrolledKey, fakeApi, keyCredential, orgModelsFor, type FakeApi } from './org-models-fixture.ts';
import { recordedClaudeUsageAnswer } from './usage-fixtures.ts';

const OWNER = '0xef8305e140ac520225daf050e2f71d5fbcc543e7';
const LOGIN = { id: 'Login123456', email: 'less@example.com', plan: 'max', savedAt: '2026-10-01T00:00:00.000Z' };
const key = enrolledKey();

let server: Server;
let backend: Server;
let api: FakeApi;
let models: OrgModels;
let base = '';
let backendBase = '';
let dir = '';
const creditsAuth: string[] = [];
const login: { asked: number; answer: () => Promise<unknown> } = { asked: 0, answer: () => Promise.resolve(null) };
let deps: ModelApiDeps = {};

beforeAll(async () => {
  api = await fakeApi(key);
  backend = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    if ((req.url ?? '').startsWith('/v1/models')) res.end(JSON.stringify(recordedClaudeModels));
    else {
      creditsAuth.push(String(req.headers.authorization ?? ''));
      res.end(JSON.stringify({ data: { limit: 50, limit_remaining: 37.5, usage: 80 } }));
    }
  });
  await new Promise<void>((r) => {
    backend.listen(0, '127.0.0.1', r);
  });
  backendBase = `http://127.0.0.1:${String((backend.address() as AddressInfo).port)}`;
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
  backend.close();
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'metro-model-api-'));
  writeFileSync(join(dir, 'model.json'), JSON.stringify({ version: 3, claude: [LOGIN] }));
  forgetUsage();
  forgetModelLists();
  creditsAuth.length = 0;
  login.asked = 0;
  login.answer = () => Promise.resolve(null);
  api.asked.length = 0;
  api.answer = null;
  api.delivery = delivery({ connection: 'or000000001', model: 'openai/gpt-5.2' }, [
    deliveredRow('or000000001', 'openrouter', { label: 'OpenRouter', zdr: true, credential: keyCredential('sk-or-secret') }),
    deliveredRow('cx000000001', 'codex', { label: 'Codex', account: { email: 'l@x', plan: 'pro', method: 'code' }, credential: { accessToken: 'at-secret', expiresAt: 1, method: 'code', accountId: 'acct' } }),
  ], [{ connection: `local:${LOGIN.id}`, model: 'claude-opus-5' }, { connection: 'cx000000001', model: 'gpt-5.4' }], 'agent');
  models = orgModelsFor(api, key, dir);
  deps = {
    dir: () => dir,
    setup: () => setupOf(models.current(), [LOGIN]),
    sync: () => models.sync(),
    syncStatus: () => models.syncStatus(),
    claudeUsage: () => {
      login.asked += 1;
      return login.answer();
    },
    claudeLogins: { probe: () => Promise.resolve(null) },
    openrouterBase: backendBase,
    anthropicBase: backendBase,
    usageWaitMs: 2_000,
  };
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
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
  chain: { connection: string; model: string; active: boolean }[];
  claude: { id: string; email: string | null }[];
  usage: Record<string, { windows: { label: string; used: number | null }[] } | undefined>;
}

const shown = async (path = '/api/model'): Promise<Shown> => (await (await call('GET', path)).json()) as Shown;

describe('the Model page reads what the organization delivered', () => {
  test('a sync from the page fetches the setup at once and answers the effective route with no secret', async () => {
    const before = await shown('/api/model/snapshot');
    expect(before).toMatchObject({ source: null, route: '', ready: true, connections: [], chain: [], claude: [LOGIN] });
    const res = await call('POST', '/api/model/sync');
    expect(res.status).toBe(200);
    const after = (await res.json()) as Shown;
    expect(api.asked.map((a) => a.path)).toEqual(['/api/agents/models']);
    expect(after).toMatchObject({ source: 'agent', route: 'or000000001', model: 'openai/gpt-5.2', ready: true, reason: null, sync: { enrolled: true, error: null } });
    expect(after.connections).toEqual([
      { id: 'or000000001', provider: 'openrouter', label: 'OpenRouter', model: '', hasKey: true, region: '', zdr: true, signedIn: false, signedOut: false, account: null, plan: null, method: null },
      { id: 'cx000000001', provider: 'codex', label: 'Codex', model: '', hasKey: false, region: '', zdr: false, signedIn: true, signedOut: false, account: 'l@x', plan: 'pro', method: 'code' },
      { id: `local:${LOGIN.id}`, provider: 'anthropic', label: LOGIN.email, model: '', hasKey: false, region: '', zdr: false, signedIn: true, signedOut: false, account: LOGIN.email, plan: 'max', method: null },
    ]);
    expect(after.fallbacks).toEqual([{ connection: `local:${LOGIN.id}`, model: 'claude-opus-5' }, { connection: 'cx000000001', model: 'gpt-5.4' }]);
    expect(after.chain.map((r) => [r.connection, r.model, r.active])).toEqual([
      ['or000000001', 'openai/gpt-5.2', true],
      [`local:${LOGIN.id}`, 'claude-opus-5', false],
      ['cx000000001', 'gpt-5.4', false],
    ]);
    for (const secret of ['sk-or-secret', 'at-secret', 'acct']) expect(JSON.stringify(after)).not.toContain(secret);
    expect((await shown('/api/model/snapshot')).route).toBe('or000000001');
  });

  test('the routes of the old Model page are gone, and every other method is refused', async () => {
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
    ] as const) {
      const res = await call(method, path);
      expect([method, path, res.status]).toEqual([method, path, path === '/api/model' ? 405 : 404]);
    }
    expect((await call('GET', '/api/model', null)).status).toBe(401);
    expect((await call('GET', '/api/model/sync')).status).toBe(405);
    expect((await call('POST', '/api/model/snapshot')).status).toBe(405);
  });

  test('the Claude models a local route may pick are the known ones, then the live list of the Claude Code login', async () => {
    const known = ((await (await call('GET', '/api/model/claude-models')).json()) as { models: { id: string }[] }).models.map((m) => m.id);
    expect(known).toContain('claude-sonnet-5-5');
    await refreshLoginModels({ authorization: 'Bearer sk-ant-oat-login' }, backendBase);
    const live = ((await (await call('GET', '/api/model/claude-models')).json()) as { models: { id: string; name: string }[] }).models;
    expect(live[0]).toEqual({ id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' });
    expect(live.map((m) => m.id)).toContain('claude-sonnet-4-5-20250929');
  });
});

describe('usage asked for before the agent sends anything', () => {
  test('an OpenRouter key is described once per five minutes, and a Codex connection is never asked', async () => {
    await models.sync();
    noteUsageHeaders('codex', 'cx000000001', new Headers({ 'x-codex-primary-used-percent': '42', 'x-codex-primary-window-minutes': '300' }));
    const first = await shown();
    expect(first.usage.or000000001?.windows).toEqual([{ label: 'Credits', used: 0.25, resetAt: null, detail: '$12.50 of $50.00 used' }]);
    expect(first.usage.cx000000001?.windows).toEqual([{ label: '5-hour window', used: 0.42, resetAt: null, detail: null }]);
    expect(creditsAuth).toEqual(['Bearer sk-or-secret']);
    await shown();
    expect(creditsAuth).toHaveLength(1);
  });

  test('with no route the Claude Code login usage is asked of Claude Code itself, once per five minutes, under local:session', async () => {
    login.answer = () => Promise.resolve(usageIn(recordedClaudeUsageAnswer));
    const none = await shown();
    expect(none.usage['local:session']?.windows.map((w) => [w.label, w.used])).toEqual([
      ['5-hour window', 0.11],
      ['Weekly, all models', 0.7],
      ['Weekly, Fable', 0],
    ]);
    await shown();
    expect(login.asked).toBe(1);
  });

  test('a slow probe never holds the page, and its answer shows on the next poll', async () => {
    deps.usageWaitMs = 50;
    let finish: (limits: unknown) => void = () => undefined;
    login.answer = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    const before = Date.now();
    expect((await shown()).usage['local:session']).toBeUndefined();
    expect(Date.now() - before).toBeLessThan(2000);
    finish(usageIn(recordedClaudeUsageAnswer));
    await Bun.sleep(20);
    expect((await shown()).usage['local:session']?.windows[0]?.used).toBe(0.11);
  });
});
