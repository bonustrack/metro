import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { forgetUsage, noteUsageHeaders } from '../src/gateway/usage.ts';
import { forgetModelLists } from '../src/gateway/model-lists.ts';
import { refreshLoginModels } from '../src/gateway/provider-models.ts';
import { recordedClaudeModels } from './claude-models-fixture.ts';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { handleModelRequest } from '../src/gateway/model-api.ts';
import { userAgent } from '../src/gateway/codex.ts';
import { codexVersion } from '../src/gateway/codex-version.ts';
import type { ModelConfig } from '../src/gateway/model-config.ts';
import { auth, type Who } from './identity-helper.ts';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jwt, makeConnection } from './model-fixture.ts';
import { usageIn } from '../src/claude/usage-probe.ts';
import { recordedClaudeUsageAnswer } from './usage-fixtures.ts';
import type { ModelApiDeps } from '../src/gateway/model-store.ts';

const OWNER = '0xef8305e140ac520225daf050e2f71d5fbcc543e7';

let server: Server;
let restarts = 0;
let issuer: Server;
let backend: Server;
let base = '';
let issuerBase = '';
let backendBase = '';
let stored: ModelConfig;
let home = '';
const creditsAuth: string[] = [];
const tokenForms: URLSearchParams[] = [];
const cliForms: URLSearchParams[] = [];
const modelAsks: { url: string; agent: string; account: string }[] = [];
const signIn = { nonce: '', sub: 'user-1' };
const cliIdToken = jwt({ email: 'less@example.com', 'https://api.openai.com/auth': { chatgpt_account_id: 'acct_1', chatgpt_plan_type: 'plus' } });
const login: { asked: number; answer: () => Promise<unknown> } = { asked: 0, answer: () => Promise.resolve(null) };
let modelDeps: ModelApiDeps = {};

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'metro-codex-home-'));
  issuer = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const url = req.url ?? '';
      const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
      if (url.includes('/deviceauth/') || url === '/oauth/token') {
        res.writeHead(200, { 'content-type': 'application/json' });
        if (url.endsWith('/usercode')) res.end(JSON.stringify({ device_auth_id: 'dev_1', user_code: 'ABCD-EFGH', interval: 1 }));
        else if (url.endsWith('/deviceauth/token')) res.end(JSON.stringify({ authorization_code: 'ac-1', code_challenge: 'ch', code_verifier: 'ver' }));
        else {
          cliForms.push(form);
          res.end(JSON.stringify({ id_token: cliIdToken, access_token: 'cli-at', refresh_token: 'cli-rt' }));
        }
        return;
      }
      tokenForms.push(form);
      const clientId = form.get('client_id') ?? '';
      const idToken = jwt({ iss: issuerBase, aud: clientId, sub: signIn.sub, nonce: signIn.nonce, email: 'less@example.com' });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id_token: idToken, access_token: 'at-1', refresh_token: 'rt-1', token_type: 'Bearer', expires_in: 3600, scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct' }));
    });
  });
  await new Promise<void>((r) => {
    issuer.listen(0, '127.0.0.1', r);
  });
  issuerBase = `http://127.0.0.1:${String((issuer.address() as AddressInfo).port)}`;
  backend = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.url === '/codex-latest') {
      res.end(JSON.stringify({ name: '@openai/codex', version: '0.158.2' }));
      return;
    }
    if ((req.url ?? '').startsWith('/v1/models') && req.headers.authorization === 'Bearer sk-ant-oat-login') {
      res.end(JSON.stringify(recordedClaudeModels));
      return;
    }
    if ((req.url ?? '').includes('/v1/models') && req.headers['x-api-key'] === undefined) {
      res.end(
        JSON.stringify({
          data: [
            { id: 'openai/gpt-5.2-codex', name: 'GPT-5.2 Codex', created: 1_760_000_000, pricing: { prompt: '0.00001', completion: '0.00005' } },
            { id: 'anthropic/claude-sonnet-4.5', name: 'Claude Sonnet 4.5', created: 1_700_000_000, pricing: { prompt: '0', completion: '-1' }, supported_parameters: ['tools', 'reasoning'] },
            { id: 'acme/translator', name: 'No tools', created: 1_770_000_000, supported_parameters: ['temperature'] },
            { id: 'acme/painter', name: 'Images only', created: 1_770_000_000, architecture: { output_modalities: ['image'] } },
            { name: 'no id' },
            7,
          ],
        }),
      );
      return;
    }
    if (req.url?.startsWith('/v1/models') === true) {
      res.end(JSON.stringify({ data: [{ id: 'claude-sonnet-5', display_name: 'Claude Sonnet 5', type: 'model' }, { id: 'claude-opus-5', display_name: 'Claude Opus 5' }, { type: 'model' }] }));
      return;
    }
    if (req.url?.startsWith('/inference-profiles') === true) {
      res.end(JSON.stringify({ inferenceProfileSummaries: [
        { inferenceProfileId: 'eu.anthropic.claude-sonnet-5', inferenceProfileName: 'EU Claude Sonnet 5', status: 'ACTIVE' },
        { inferenceProfileId: 'eu.amazon.nova-pro', inferenceProfileName: 'Nova', status: 'ACTIVE' },
        { inferenceProfileId: 'eu.anthropic.claude-old', inferenceProfileName: 'Old', status: 'INACTIVE' },
      ] }));
      return;
    }
    if (req.url === '/v1/key') {
      creditsAuth.push(String(req.headers.authorization ?? ''));
      res.end(JSON.stringify({ data: { label: 'sk-or-v1-abc...xyz', limit: 50, limit_remaining: 37.5, limit_reset: null, usage: 80, is_free_tier: false } }));
      return;
    }
    if (req.url === '/token') {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
        googleForms.push(form);
        if (form.get('code') === 'bad-code') {
          res.end(JSON.stringify({ error: 'invalid_grant', error_description: 'Bad Request' }));
          return;
        }
        res.end(JSON.stringify({ access_token: 'g-at', refresh_token: 'g-rt', expires_in: 3599 }));
      });
      return;
    }
    if (req.url === '/oauth2/v2/userinfo') {
      res.end(JSON.stringify({ email: 'less@gmail.com' }));
      return;
    }
    if (req.url === '/v1internal:loadCodeAssist') {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        loadAsked.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>);
        if (ineligible.on) {
          res.end(JSON.stringify({ ineligibleTiers: [{ tierId: 'free-tier', reasonCode: 'DASHER_USER', reasonMessage: 'Your account is not eligible for Gemini Code Assist for individuals at this time' }] }));
          return;
        }
        if (managed.on) {
          res.end(JSON.stringify({ currentTier: { id: 'standard-tier', name: 'Standard' }, cloudaicompanionProject: '' }));
          return;
        }
        res.end(JSON.stringify({ allowedTiers: [{ id: 'legacy-tier' }, { id: 'free-tier', isDefault: true, name: 'Google AI Pro' }], cloudaicompanionProject: '' }));
      });
      return;
    }
    if (req.url === '/v1internal:onboardUser') {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        onboardTiers.push(String((JSON.parse(Buffer.concat(chunks).toString('utf8')) as { tierId: string }).tierId));
        res.end(JSON.stringify({ done: true, response: { cloudaicompanionProject: { id: 'managed-proj-7' } } }));
      });
      return;
    }
    if (req.url === '/v1internal:fetchAvailableModels') {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        modelsAsked.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>);
        res.end(
          JSON.stringify({
            models: {
              'gemini-3.8-flash-tiered': { displayName: 'Gemini 3.8 Flash', quotaInfo: { remainingFraction: 0.75, resetTime: '2026-09-21T10:00:00Z' } },
              'gemini-3.1-pro-high': { displayName: 'Gemini 3.1 Pro' },
              'claude-sonnet-4-6': { displayName: 'Claude Sonnet', quotaInfo: { remainingFraction: 1 } },
            },
          }),
        );
      });
      return;
    }
    if (req.url === '/v1/endpoints/zdr') {
      res.end(JSON.stringify({ data: [{ model_id: 'openai/gpt-5.2-codex', provider_name: 'OpenAI' }, { model_id: 'anthropic/claude-sonnet-4.5' }, { model_id: 'anthropic/claude-sonnet-4.5' }, { name: 'no id' }] }));
      return;
    }
    modelAsks.push({ url: req.url ?? '', agent: String(req.headers['user-agent']), account: String(req.headers['chatgpt-account-id']) });
    res.end(JSON.stringify({ models: [{ slug: 'gpt-5.3-codex', display_name: 'GPT-5.3 Codex', visibility: 'list' }, { slug: 'codex-auto-review', visibility: 'hide' }] }));
  });
  await new Promise<void>((r) => {
    backend.listen(0, '127.0.0.1', r);
  });
  backendBase = `http://127.0.0.1:${String((backend.address() as AddressInfo).port)}`;
  process.env.METRO_CODEX_REGISTRY = `${backendBase}/codex-latest`;
  modelDeps = {
    read: () => stored,
    write: (cfg) => {
      stored = cfg;
    },
    issuer: issuerBase,
    codexBase: backendBase,
    openrouterBase: backendBase,
    anthropicBase: backendBase,
    bedrockControlBase: backendBase,
    geminiAuthBase: backendBase,
    geminiTokenBase: backendBase,
    geminiUserBase: backendBase,
    geminiBase: backendBase,
    setup: { dir: join(home, 'claude'), agents: join(home, 'agents') },
    restartSession: () => {
      restarts += 1;
      return true;
    },
    claudeUsage: () => {
      login.asked += 1;
      return login.answer();
    },
  };
  server = createServer((req, res) => {
    if (handleModelRequest(req, res, modelDeps)) return;
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => {
    server.listen(0, '127.0.0.1', r);
  });
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

afterAll(() => {
  server.close();
  issuer.close();
  backend.close();
  rmSync(home, { recursive: true, force: true });
});

beforeEach(() => {
  forgetUsage();
  forgetModelLists();
  creditsAuth.length = 0;
  tokenForms.length = 0;
  cliForms.length = 0;
  modelAsks.length = 0;
  signIn.sub = 'user-1';
  login.asked = 0;
  login.answer = () => Promise.resolve(null);
  modelDeps.usageWaitMs = undefined;
  googleForms.length = 0;
  stored = { version: 2, route: '', connections: [] };
  restarts = 0;
});

const conns = async (method: string, path = '', body?: unknown): Promise<Response> =>
  fetch(`${base}/api/model/connections${path}`, {
    method,
    headers: {
      authorization: await auth(OWNER),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const add = async (body: unknown): Promise<string> => {
  const made = (await (await conns('POST', '', body)).json()) as { connections: { id: string }[] };
  return made.connections.at(-1)?.id ?? '';
};

const call = async (method: string, who: Who | null, body?: unknown): Promise<Response> =>
  fetch(`${base}/api/model`, {
    method,
    headers: {
      ...(who === null ? {} : { authorization: await auth(who) }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

describe('the connections on the page', () => {
  test('the owner starts with none, adds one per credential, and several of one provider live side by side', async () => {
    const before = await call('GET', OWNER);
    expect(before.status).toBe(200);
    expect(await before.json()).toMatchObject({ route: '', ready: true, connections: [] });

    const first = await conns('POST', '', { provider: 'openrouter', apiKey: 'or-key', model: 'openai/gpt-5.2-codex' });
    expect(first.status).toBe(200);
    const body = (await first.json()) as { route: string; connections: { id: string; label: string; hasKey: boolean; model: string }[] };
    expect(body.connections).toHaveLength(1);
    expect(body.connections[0]).toMatchObject({ label: 'OpenRouter', hasKey: true, model: 'openai/gpt-5.2-codex' });
    expect(body.route).toBe(body.connections[0]?.id ?? '');
    expect(JSON.stringify(body)).not.toContain('or-key');
    expect(stored.connections[0]?.apiKey).toBe('or-key');

    const second = await add({ provider: 'openrouter', apiKey: 'other-key', model: 'anthropic/claude-sonnet-4.5' });
    expect(stored.connections.map((c) => c.label)).toEqual(['OpenRouter', 'OpenRouter 2']);
    expect(stored.route).toBe(stored.connections[0]?.id);

    const restartsBefore = restarts;
    const routed = await call('PUT', OWNER, { route: second });
    expect(((await routed.json()) as { route: string }).route).toBe(second);
    expect(stored.route).toBe(second);
    expect(restarts).toBe(restartsBefore + 1);
    await conns('PUT', `/${second}`, { label: 'Work' });
    expect(restarts).toBe(restartsBefore + 1);
  });

  test('a connection is renamed, edited and removed on its own; removing the routed one moves the route', async () => {
    const one = await add({ provider: 'openrouter', apiKey: 'k1', model: 'a/b' });
    const two = await add({ provider: 'openrouter', apiKey: 'k2', model: 'c/d' });
    const renamed = await conns('PUT', `/${two}`, { label: 'Work', zdr: true });
    expect(renamed.status).toBe(200);
    expect(stored.connections[1]).toMatchObject({ label: 'Work', zdr: true, apiKey: 'k2', model: 'c/d' });
    expect(stored.connections[0]).toMatchObject({ label: 'OpenRouter', zdr: false, apiKey: 'k1' });

    expect((await conns('PUT', '/cn-nope', { label: 'x' })).status).toBe(400);
    expect((await conns('PUT', `/${two}`, { zdr: 'yes' })).status).toBe(400);
    expect((await conns('POST', '', { provider: 'mars' })).status).toBe(400);

    const gone = await conns('DELETE', `/${one}`);
    expect(gone.status).toBe(200);
    expect(stored.connections.map((c) => c.id)).toEqual([two]);
    expect(stored.route).toBe(two);
    expect((await conns('DELETE', `/${one}`)).status).toBe(400);
  });

  test('the settings carry what each connection last said about its quota, and an OpenRouter key is described once per five minutes', async () => {
    const quiet = (await (await call('GET', OWNER)).json()) as { usage: Record<string, unknown> };
    expect(quiet.usage).toEqual({});
    expect(creditsAuth).toEqual([]);

    const id = await add({ provider: 'openrouter', apiKey: 'or-key', model: 'x/y' });
    noteUsageHeaders('codex', 'cn-codex', new Headers({ 'x-codex-primary-used-percent': '42', 'x-codex-primary-window-minutes': '300' }));
    const first = (await (await call('GET', OWNER)).json()) as { usage: Record<string, { windows: { label: string; used: number | null; detail: string | null }[] }> };
    expect(first.usage['cn-codex']?.windows).toEqual([{ label: '5-hour window', used: 0.42, resetAt: null, detail: null }]);
    expect(first.usage[id]?.windows).toEqual([{ label: 'Credits', used: 0.25, resetAt: null, detail: '$12.50 of $50.00 used' }]);
    expect(creditsAuth).toEqual(['Bearer or-key']);
    expect(JSON.stringify(first)).not.toContain('or-key');

    await call('GET', OWNER);
    expect(creditsAuth).toHaveLength(1);
    await conns('PUT', `/${id}`, { label: 'Work' });
    await call('GET', OWNER);
    expect(creditsAuth).toHaveLength(1);
    await conns('PUT', `/${id}`, { apiKey: 'or-key-2' });
    await call('GET', OWNER);
    expect(creditsAuth).toEqual(['Bearer or-key', 'Bearer or-key-2']);
    await conns('DELETE', `/${id}`);
    expect(((await (await call('GET', OWNER)).json()) as { usage: Record<string, unknown> }).usage[id]).toBeUndefined();
  });

  test('a bad body is a 400 naming the field, no signature a 401, other methods 405', async () => {
    const bad = await call('PUT', OWNER, { route: 'cn-nope' });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toContain('connection');
    expect((await call('GET', null)).status).toBe(401);
    expect((await call('DELETE', OWNER)).status).toBe(405);
    expect(stored.route).toBe('');
  });
});

const googleForms: URLSearchParams[] = [];
const ineligible = { on: false };
const managed = { on: false };
const loadAsked: Record<string, unknown>[] = [];
const modelsAsked: Record<string, unknown>[] = [];
const onboardTiers: string[] = [];

const gemini = async (name: string, method: 'GET' | 'POST', body?: unknown): Promise<Response> =>
  fetch(`${base}/api/model/gemini/${name}`, {
    method,
    headers: {
      authorization: await auth(OWNER),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const codex = async (name: string, method: 'GET' | 'POST', body?: unknown): Promise<Response> =>
  fetch(`${base}/api/model/codex/${name}`, {
    method,
    headers: {
      authorization: await auth(OWNER),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

type Shown = { connections: Record<string, unknown>[]; usage: Record<string, { windows: { label: string; used: number | null }[] } | undefined> };

const shown = async (): Promise<Shown> => (await (await call('GET', OWNER)).json()) as Shown;

const pause = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const codexSignIn = async (connection = ''): Promise<{ url: URL; done: Response }> => {
  const query = connection === '' ? '' : `?connection=${connection}`;
  const started = (await (await codex(`login${query}`, 'POST')).json()) as { url: string };
  const url = new URL(started.url);
  signIn.nonce = url.searchParams.get('nonce') ?? '';
  const issued = url.searchParams.get('client_id') === 'dynamic_agent_client' ? '&client_id=oaiapp_1' : '';
  const done = await codex(`callback${query}`, 'POST', { url: `http://127.0.0.1:1455/auth/callback?code=the-code&state=${url.searchParams.get('state') ?? ''}${issued}` });
  return { url, done };
};

describe('usage asked for before the agent sends anything', () => {
  test('a Codex connection shows the account it signed in with, and no usage endpoint is asked for it', async () => {
    const { done } = await codexSignIn();
    expect(done.status).toBe(200);
    const id = stored.connections[0]?.id ?? '';
    const settings = await shown();
    expect(settings.connections[0]).toMatchObject({ id, account: 'less@example.com', plan: null });
    expect(settings.usage[id]).toBeUndefined();
    expect(JSON.stringify(settings)).not.toContain('at-1');
  });

  test('the Claude Code login usage is asked of Claude Code itself, for a box with no connection and for each keyless Anthropic connection', async () => {
    login.answer = () => Promise.resolve(usageIn(recordedClaudeUsageAnswer));
    const none = await shown();
    expect(none.usage.passthrough?.windows.map((w) => [w.label, w.used])).toEqual([
      ['5-hour window', 0.11],
      ['Weekly', 0.7],
      ['Weekly, Fable', 0],
    ]);
    expect(login.asked).toBe(1);
    await shown();
    expect(login.asked).toBe(1);

    const keyless = await add({ provider: 'anthropic' });
    const keyed = await add({ provider: 'anthropic', apiKey: 'sk-ant-key' });
    const both = await shown();
    expect(both.usage[keyless]?.windows[0]?.label).toBe('5-hour window');
    expect(both.usage[keyed]).toBeUndefined();
    expect(login.asked).toBe(1);

    forgetUsage();
    const again = await shown();
    expect(again.usage[keyless]?.windows[0]?.label).toBe('5-hour window');
    expect(again.usage.passthrough).toBeUndefined();
    expect(login.asked).toBe(2);
  });

  test('a fresher answer from the gateway is kept, a failed probe waits five minutes, and a slow one never holds the page', async () => {
    const id = await add({ provider: 'anthropic' });
    noteUsageHeaders('anthropic', id, new Headers({ 'anthropic-ratelimit-unified-5h-utilization': '0.5' }));
    expect((await shown()).usage[id]?.windows[0]?.used).toBe(0.5);
    expect(login.asked).toBe(0);

    forgetUsage();
    login.answer = () => Promise.reject(new Error('not signed in'));
    await shown();
    await shown();
    expect(login.asked).toBe(1);

    forgetUsage();
    modelDeps.usageWaitMs = 50;
    let finish: (limits: unknown) => void = () => undefined;
    login.answer = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    const before = Date.now();
    expect((await shown()).usage[id]).toBeUndefined();
    expect(Date.now() - before).toBeLessThan(2000);
    finish(usageIn(recordedClaudeUsageAnswer));
    await pause(20);
    expect((await shown()).usage[id]?.windows[0]?.used).toBe(0.11);
  });
});

describe('the model setup as a whole, for the export file', () => {
  test('the owner reads it with its keys and writes it back; anything else is refused', async () => {
    await add({ provider: 'openrouter', apiKey: 'or-key', model: 'google/gemini-3.8-flash', zdr: true });
    const bundle = await fetch(`${base}/api/model/bundle`, { headers: { authorization: await auth(OWNER) } });
    expect(bundle.status).toBe(200);
    const body = (await bundle.json()) as ModelConfig;
    expect(body.connections[0]).toMatchObject({ provider: 'openrouter', apiKey: 'or-key', model: 'google/gemini-3.8-flash', zdr: true });
    stored = { version: 2, route: '', connections: [] };
    const restored = await fetch(`${base}/api/model/restore`, {
      method: 'POST',
      headers: { authorization: await auth(OWNER), 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(restored.status).toBe(200);
    expect(((await restored.json()) as { connections: Record<string, unknown>[] }).connections[0]).toMatchObject({ provider: 'openrouter', model: 'google/gemini-3.8-flash', hasKey: true, zdr: true });
    expect(stored.connections[0]?.apiKey).toBe('or-key');
    const bad = await fetch(`${base}/api/model/restore`, {
      method: 'POST',
      headers: { authorization: await auth(OWNER), 'content-type': 'application/json' },
      body: '[]',
    });
    expect(bad.status).toBe(400);
  });
});

describe('connecting ChatGPT for Codex from the page', () => {
  test("login registers Metro with this box's host id, the pasted callback finishes it, and the tokens never reach the page", async () => {
    const { url, done } = await codexSignIn();
    expect(url.origin + url.pathname).toBe(`${issuerBase}/api/accounts/authorize`);
    expect(url.searchParams.get('client_id')).toBe('dynamic_agent_client');
    expect(url.searchParams.get('agent_name_hint')).toBe('Metro');
    const host = (JSON.parse(readFileSync(join(home, 'agents', 'chatgpt-host.json'), 'utf8')) as { hostId: string }).hostId;
    expect(url.searchParams.get('ext_agent_host_id')).toBe(host);
    expect(done.status).toBe(200);
    const shown = (await done.json()) as { connections: Record<string, unknown>[] };
    expect(shown.connections[0]).toMatchObject({ provider: 'codex', label: 'Codex (ChatGPT)', signedIn: true, account: 'less@example.com', plan: null, method: 'chatgpt' });
    expect(JSON.stringify(shown)).not.toContain('at-1');
    expect(stored.connections[0]?.codex).toMatchObject({ method: 'chatgpt', clientId: 'oaiapp_1', subject: 'user-1', accessToken: 'at-1', refreshToken: 'rt-1' });
    expect(tokenForms[0]?.get('client_id')).toBe('oaiapp_1');
    const stale = await codex('callback', 'POST', { url: 'http://127.0.0.1:1455/auth/callback?code=c&state=nope&client_id=oaiapp_1' });
    expect(stale.status).toBe(400);
    const models = await codex('models', 'GET');
    expect(await models.json()).toEqual({ models: ['gpt-5.3-codex'] });
    expect(modelAsks.map((ask) => [ask.url, ask.account])).toEqual([['/models', 'undefined']]);
    expect(modelAsks[0]?.agent).not.toContain('codex');
    const id = String(shown.connections[0]?.id);
    expect((await conns('DELETE', `/${id}`)).status).toBe(200);
    expect(stored.connections).toEqual([]);
    expect((await codex('models', 'GET')).status).toBe(400);
  });

  test('a connection that is not signed in signs in in place, then reuses its client, and never takes another account', async () => {
    stored = { version: 2, route: 'cn-codex', connections: [makeConnection('codex', { model: 'gpt-5.4' })], fallbacks: [{ connection: 'cn-codex', model: 'gpt-5.4-mini' }] };
    expect((await shown()).connections[0]).toMatchObject({ id: 'cn-codex', signedIn: false });
    const first = await codexSignIn('cn-codex');
    expect(first.url.searchParams.get('client_id')).toBe('dynamic_agent_client');
    expect(first.done.status).toBe(200);
    expect(stored.connections).toHaveLength(1);
    expect(stored.connections[0]).toMatchObject({ id: 'cn-codex', model: 'gpt-5.4', codex: { clientId: 'oaiapp_1' } });
    expect(stored.fallbacks).toEqual([{ connection: 'cn-codex', model: 'gpt-5.4-mini' }]);
    const again = await codexSignIn('cn-codex');
    expect(again.url.searchParams.get('client_id')).toBe('oaiapp_1');
    expect(again.url.searchParams.get('agent_name_hint')).toBeNull();
    expect(again.url.searchParams.get('login_hint')).toBe('less@example.com');
    expect(again.done.status).toBe(200);
    signIn.sub = 'user-2';
    const other = await codexSignIn('cn-codex');
    expect(other.done.status).toBe(400);
    expect(((await other.done.json()) as { error: string }).error).toContain('another ChatGPT account');
    expect((await codex('login?connection=cn-nope', 'POST')).status).toBe(404);
  });

  test('the Codex CLI login import is gone, a login is a POST, and a code is asked with a POST and polled with a GET', async () => {
    expect((await codex('import', 'POST')).status).toBe(404);
    expect((await codex('login', 'GET')).status).toBe(405);
    expect((await codex('device', 'GET')).status).toBe(405);
    expect((await codex('device/short', 'GET')).status).toBe(404);
    expect((await codex('device/abcdefghijklmnopqrstuvwx', 'POST')).status).toBe(405);
    expect((await codex('device/abcdefghijklmnopqrstuvwx', 'GET')).status).toBe(400);
  });
});

describe('signing Codex in with a code from the page', () => {
  test('a code is issued, the page polls, the tokens land in the model file as a code sign-in, and its models come from the ChatGPT backend as the Codex app', async () => {
    const started = await codex('device', 'POST');
    expect(started.status).toBe(200);
    const login = (await started.json()) as { id: string; user_code: string; verify_url: string; interval: number };
    expect(login).toMatchObject({ user_code: 'ABCD-EFGH', verify_url: `${issuerBase}/codex/device`, interval: 1 });
    const done = await codex(`device/${login.id}`, 'GET');
    expect(done.status).toBe(200);
    const settings = ((await done.json()) as { status: string; settings: { connections: Record<string, unknown>[] } }).settings;
    expect(settings.connections[0]).toMatchObject({ provider: 'codex', signedIn: true, account: 'less@example.com', plan: 'plus', method: 'code' });
    expect(JSON.stringify(settings)).not.toContain('cli-at');
    expect(stored.connections[0]?.codex).toMatchObject({ method: 'code', accountId: 'acct_1', accessToken: 'cli-at', refreshToken: 'cli-rt' });
    expect(cliForms[0]?.get('client_id')).toBe('app_EMoamEEZ73f0CkXaXp7hrann');
    expect((await codex(`device/${login.id}`, 'GET')).status).toBe(400);
    expect(await (await codex('models', 'GET')).json()).toEqual({ models: ['gpt-5.3-codex'] });
    expect(modelAsks).toEqual([{ url: '/models?client_version=0.158.2', agent: userAgent(), account: 'acct_1' }]);
    expect(userAgent()).toStartWith('codex_cli_rs/0.158.2 (');
  });

  test('a connection moves to the other sign-in in place, keeping its model and fallbacks', async () => {
    await codexSignIn();
    const id = stored.connections[0]?.id ?? '';
    stored = { ...stored, connections: stored.connections.map((c) => ({ ...c, model: 'gpt-5.4' })), fallbacks: [{ connection: id, model: 'gpt-5.4-mini' }] };
    const login = (await (await codex('device', 'POST')).json()) as { id: string };
    expect((await codex(`device/${login.id}?connection=${id}`, 'GET')).status).toBe(200);
    expect(stored.connections).toHaveLength(1);
    expect(stored.connections[0]).toMatchObject({ id, model: 'gpt-5.4', codex: { method: 'code', accountId: 'acct_1' } });
    expect(stored.fallbacks).toEqual([{ connection: id, model: 'gpt-5.4-mini' }]);
    const back = await codexSignIn(id);
    expect(back.url.searchParams.get('client_id')).toBe('dynamic_agent_client');
    expect(back.done.status).toBe(200);
    expect(stored.connections[0]).toMatchObject({ id, model: 'gpt-5.4', codex: { method: 'chatgpt', clientId: 'oaiapp_1' } });
  });

  test('the Codex app version metro announces is the latest Codex CLI on npm, and it can be overridden', async () => {
    const code = { method: 'code' as const, accountId: 'acct_9', email: null, plan: 'pro', accessToken: 'at-9', refreshToken: 'rt-9', expiresAt: Date.now() + 3_600_000, savedAt: new Date().toISOString() };
    stored = { version: 2, route: 'cn-codex', connections: [makeConnection('codex', { codex: code })] };
    expect((await codex('models', 'GET')).status).toBe(200);
    expect(modelAsks.at(-1)?.url).toBe('/models?client_version=0.158.2');
    expect(codexVersion()).toBe('0.158.2');
    process.env.METRO_CODEX_VERSION = '0.160.0';
    try {
      expect((await codex('models', 'GET')).status).toBe(200);
      expect(modelAsks.at(-1)).toMatchObject({ url: '/models?client_version=0.160.0', account: 'acct_9' });
      expect(userAgent()).toContain('codex_cli_rs/0.160.0');
      process.env.METRO_CODEX_VERSION = 'not a version';
      expect(codexVersion()).toBe('0.158.2');
    } finally {
      delete process.env.METRO_CODEX_VERSION;
    }
  });
});

describe('connecting Google for Gemini from the page', () => {
  test('login hands back the Google link with PKCE, the pasted code finishes it after onboarding, and the tokens never reach the page', async () => {
    const started = (await (await gemini('login', 'POST')).json()) as { url: string; state: string };
    const url = new URL(started.url);
    expect(url.origin).toBe(backendBase);
    expect(url.pathname).toBe('/o/oauth2/v2/auth');
    expect(url.searchParams.get('client_id')).toBe('1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com');
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:51121/oauth-callback');
    expect(url.searchParams.get('scope')).toContain('https://www.googleapis.com/auth/cclog');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('state')).toBe(started.state);
    expect((await gemini('code', 'POST', { code: 'x', state: 'nope' })).status).toBe(400);
    const rejected = await gemini('code', 'POST', { code: 'bad-code', state: started.state });
    expect(rejected.status).toBe(400);
    expect(((await rejected.json()) as { error: string }).error).toContain('Bad Request');
    const other = (await (await gemini('login', 'POST')).json()) as { state: string };
    const foreign = await gemini('code', 'POST', { code: `http://localhost:51121/oauth-callback?code=4%2Fzz&state=someone-else`, state: other.state });
    expect(foreign.status).toBe(400);
    expect(((await foreign.json()) as { error: string }).error).toContain('another sign-in');
    const again = (await (await gemini('login', 'POST')).json()) as { state: string };
    const done = await gemini('code', 'POST', { code: `http://localhost:51121/oauth-callback?state=${again.state}&code=4%2F0AbCdEf&scope=email`, state: again.state });
    expect(done.status).toBe(200);
    const shown = (await done.json()) as { connections: Record<string, unknown>[] };
    expect(shown.connections[0]).toMatchObject({ provider: 'gemini', signedIn: true, account: 'less@gmail.com', plan: 'Google AI Pro' });
    expect(JSON.stringify(shown)).not.toContain('g-at');
    expect(googleForms.at(-1)?.get('grant_type')).toBe('authorization_code');
    expect(googleForms.at(-1)?.get('code')).toBe('4/0AbCdEf');
    expect(googleForms.at(-1)?.get('redirect_uri')).toBe('http://localhost:51121/oauth-callback');
    expect(googleForms.at(-1)?.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(stored.connections[0]?.gemini).toMatchObject({ accessToken: 'g-at', refreshToken: 'g-rt', project: 'managed-proj-7', tier: 'Google AI Pro', email: 'less@gmail.com' });
    expect(onboardTiers).toEqual(['free-tier']);
    expect(loadAsked.at(-1)).toEqual({ metadata: { ideType: 9, platform: expect.any(Number) as unknown, pluginType: 2 }, mode: 1 });
    expect(await (await gemini('models', 'GET')).json()).toEqual({ models: ['gemini-3.8-flash-tiered', 'gemini-3.1-pro-high'] });
    expect(modelsAsked.at(-1)).toEqual({ project: 'managed-proj-7' });
    const geminiId = String(shown.connections[0]?.id);
    const quiet = (await (await fetch(`${base}/api/model`, { headers: { authorization: await auth(OWNER) } })).json()) as { usage: Record<string, unknown> };
    expect(quiet.usage[geminiId]).toBeUndefined();
    await conns('PUT', `/${geminiId}`, { model: 'gemini-3.8-flash-tiered' });
    const settings = (await (await fetch(`${base}/api/model`, { headers: { authorization: await auth(OWNER) } })).json()) as { usage: Record<string, { windows: { label: string; used: number; resetAt: string; detail: string | null }[] }> };
    expect(settings.usage[geminiId]?.windows).toEqual([{ label: 'gemini-3.8-flash-tiered', used: 0.25, resetAt: '2026-09-21T10:00:00Z', detail: null }]);
    expect((await conns('DELETE', `/${geminiId}`)).status).toBe(200);
    expect(stored.connections).toEqual([]);
    expect((await gemini('dance', 'POST')).status).toBe(404);
    expect((await gemini('login', 'GET')).status).toBe(405);
  });

  test('an account Google will not onboard is refused with Google\'s sentence and the reason code explained', async () => {
    ineligible.on = true;
    try {
      const started = (await (await gemini('login', 'POST')).json()) as { state: string };
      const refused = await gemini('code', 'POST', { code: '4/ok', state: started.state });
      expect(refused.status).toBe(400);
      const text = ((await refused.json()) as { error: string }).error;
      expect(text).toContain('not eligible for Gemini Code Assist for individuals');
      expect(text).toContain('[DASHER_USER: this is a Google Workspace account');
      expect(stored.connections).toEqual([]);
    } finally {
      ineligible.on = false;
    }
  });

  test('a licensed account needs the project that carries the licence, and connects with it', async () => {
    managed.on = true;
    loadAsked.length = 0;
    try {
      const started = (await (await gemini('login', 'POST')).json()) as { state: string };
      const refused = await gemini('code', 'POST', { code: '4/ok', state: started.state });
      expect(refused.status).toBe(400);
      expect(((await refused.json()) as { error: string }).error).toContain('named no project');
      expect(stored.connections).toEqual([]);
      expect(loadAsked.at(-1)).toEqual({ metadata: { ideType: 9, platform: expect.any(Number) as unknown, pluginType: 2 }, mode: 1 });
      const bad = (await (await gemini('login', 'POST')).json()) as { state: string };
      const shape = await gemini('code', 'POST', { code: '4/ok', state: bad.state, project: 'Not A Project' });
      expect(shape.status).toBe(400);
      expect(((await shape.json()) as { error: string }).error).toContain('not a Google Cloud project id');
      const again = (await (await gemini('login', 'POST')).json()) as { state: string };
      const done = await gemini('code', 'POST', { code: '4/ok', state: again.state, project: 'stage-metro-1' });
      expect(done.status).toBe(200);
      expect(((await done.json()) as { connections: Record<string, unknown>[] }).connections[0]).toMatchObject({ signedIn: true, plan: 'Standard' });
      expect(stored.connections[0]?.gemini).toMatchObject({ project: 'stage-metro-1', tier: 'Standard' });
      expect(loadAsked.at(-1)).toEqual({ metadata: { ideType: 9, platform: expect.any(Number) as unknown, pluginType: 2, duetProject: 'stage-metro-1' }, mode: 1, cloudaicompanionProject: 'stage-metro-1' });
    } finally {
      managed.on = false;
    }
  });
});

describe('picking an OpenRouter model without typing its id', () => {
  test('the daemon lists the chat models OpenRouter serves, newest first, dropping rows with no id, no tools or no text out', async () => {
    const res = await fetch(`${base}/api/model/openrouter/models`, {
      headers: { authorization: await auth(OWNER) },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      models: [
        { id: 'openai/gpt-5.2-codex', name: 'GPT-5.2 Codex', prompt: 0.00001, completion: 0.00005, created: 1_760_000_000 },
        { id: 'anthropic/claude-sonnet-4.5', name: 'Claude Sonnet 4.5', prompt: 0, completion: null, created: 1_700_000_000 },
      ],
    });
    const wrong = await fetch(`${base}/api/model/openrouter/nope`, {
      headers: { authorization: await auth(OWNER) },
    });
    expect(wrong.status).toBe(404);
  });
});

describe('zero data retention on OpenRouter', () => {
  test('the daemon lists the models with a zero data retention endpoint, once each, sorted', async () => {
    const res = await fetch(`${base}/api/model/openrouter/zdr`, {
      headers: { authorization: await auth(OWNER) },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ models: ['anthropic/claude-sonnet-4.5', 'openai/gpt-5.2-codex'] });
  });
});

describe('picking an Anthropic or Bedrock model without typing its id', () => {
  test('Anthropic lists the known Claude models without a key, and the account list with one', async () => {
    await add({ provider: 'anthropic' });
    const res = await fetch(`${base}/api/model/anthropic/models`, { headers: { authorization: await auth(OWNER) } });
    expect(res.status).toBe(200);
    const known = ((await res.json()) as { models: { id: string }[] }).models.map((m) => m.id);
    expect(known).toContain('claude-sonnet-5');
    expect(known).toContain('claude-opus-5-5');
    stored.connections[0] = { ...stored.connections[0]!, apiKey: 'sk-ant' };
    const live = await fetch(`${base}/api/model/anthropic/models`, { headers: { authorization: await auth(OWNER) } });
    expect(await live.json()).toEqual({ models: [{ id: 'claude-opus-5', name: 'Claude Opus 5' }, { id: 'claude-sonnet-5', name: 'Claude Sonnet 5' }] });
  });

  test('Anthropic lists the live models of the Claude Code login once a request has carried it, so a new model shows up without a release', async () => {
    await add({ provider: 'anthropic' });
    await refreshLoginModels({ authorization: 'Bearer sk-ant-oat-login' }, backendBase);
    const res = await fetch(`${base}/api/model/anthropic/models`, { headers: { authorization: await auth(OWNER) } });
    const models = ((await res.json()) as { models: { id: string; name: string }[] }).models;
    expect(models[0]).toEqual({ id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' });
    expect(models.map((m) => m.id)).toContain('claude-sonnet-4-5-20250929');
  });

  test('Bedrock lists the active Anthropic inference profiles of the region, and says why when it cannot', async () => {
    const refused = await fetch(`${base}/api/model/bedrock/models`, { headers: { authorization: await auth(OWNER) } });
    expect(refused.status).toBe(400);
    await add({ provider: 'bedrock', region: 'eu-central-1', apiKey: 'aws-key' });
    const res = await fetch(`${base}/api/model/bedrock/models`, { headers: { authorization: await auth(OWNER) } });
    expect(await res.json()).toEqual({ models: [{ id: 'eu.anthropic.claude-sonnet-5', name: 'EU Claude Sonnet 5' }] });
  });

  test('saving a non-Anthropic route writes the Claude Code model allowlist, and saving Anthropic back removes it', async () => {
    await add({ provider: 'openrouter', apiKey: 'or-key', model: 'anthropic/claude-sonnet-5' });
    const settingsPath = join(home, 'claude', 'settings.json');
    expect(JSON.parse(readFileSync(settingsPath, 'utf8'))).toMatchObject({ availableModels: ['openrouter:anthropic/claude-sonnet-5'], enforceAvailableModels: true });
    const anthropic = await add({ provider: 'anthropic' });
    await call('PUT', OWNER, { route: anthropic });
    expect(JSON.parse(readFileSync(settingsPath, 'utf8'))).not.toHaveProperty('availableModels');
  });
});

describe('the Agent SDK session follows the Model page live', () => {
  const setupFile = (): string => join(home, 'agents', 'claude-setup.json');
  const runnerIs = (runner: 'cli' | 'sdk'): void => {
    mkdirSync(join(home, 'agents'), { recursive: true });
    writeFileSync(setupFile(), JSON.stringify({ runner }));
  };

  test('a new model or route goes to the running session, which switches without a restart; the same model sends nothing', async () => {
    const told: (string | null)[] = [];
    modelDeps.switchModel = (model) => {
      told.push(model);
      return true;
    };
    runnerIs('sdk');
    try {
      const sonnet = await add({ provider: 'openrouter', apiKey: 'or-key', model: 'anthropic/claude-sonnet-5.5' });
      const keyed = await add({ provider: 'anthropic', apiKey: 'sk-ant', model: 'claude-opus-5-5' });
      expect(told).toEqual(['openrouter:anthropic/claude-sonnet-5.5']);
      await conns('PUT', `/${sonnet}`, { model: 'openai/gpt-6.1' });
      await conns('PUT', `/${sonnet}`, { label: 'Work' });
      await call('PUT', OWNER, { route: keyed });
      await conns('PUT', `/${keyed}`, { model: 'claude-sonnet-5-5' });
      expect(told).toEqual(['openrouter:anthropic/claude-sonnet-5.5', 'openrouter:openai/gpt-6.1', 'claude-opus-5-5', 'claude-sonnet-5-5']);
      expect(restarts).toBe(0);
    } finally {
      modelDeps.switchModel = undefined;
      rmSync(setupFile(), { force: true });
    }
  });

  test('fallback models are routed by the gateway, so a keyed list neither switches nor restarts the session, and a fallback without an API key stops it at once', async () => {
    const told: (string | null)[] = [];
    modelDeps.switchModel = (model) => {
      told.push(model);
      return true;
    };
    runnerIs('sdk');
    const fallbacks = async (list: { connection: string; model: string }[]): Promise<number> => {
      const res = await fetch(`${base}/api/model/fallbacks`, {
        method: 'PUT',
        headers: { authorization: await auth(OWNER), 'content-type': 'application/json' },
        body: JSON.stringify({ fallbacks: list }),
      });
      await res.text();
      return res.status;
    };
    try {
      await add({ provider: 'openrouter', apiKey: 'or-key', model: 'anthropic/claude-sonnet-5.5' });
      const keyed = await add({ provider: 'anthropic', apiKey: 'sk-ant', model: 'claude-opus-5-5' });
      const login = await add({ provider: 'anthropic' });
      expect(await fallbacks([{ connection: keyed, model: 'claude-opus-5-5' }])).toBe(200);
      expect({ told, restarts }).toEqual({ told: ['openrouter:anthropic/claude-sonnet-5.5'], restarts: 0 });
      expect(await fallbacks([{ connection: keyed, model: 'claude-opus-5-5' }, { connection: login, model: 'claude-opus-5-5' }])).toBe(200);
      expect({ told, restarts }).toEqual({ told: ['openrouter:anthropic/claude-sonnet-5.5'], restarts: 1 });
    } finally {
      modelDeps.switchModel = undefined;
      rmSync(setupFile(), { force: true });
    }
  });

  test('a session that cannot be told restarts on the new model, and the Claude Code session keeps restarting as before', async () => {
    modelDeps.switchModel = () => false;
    runnerIs('sdk');
    try {
      const one = await add({ provider: 'openrouter', apiKey: 'or-key', model: 'a/b' });
      expect(restarts).toBe(1);
      await conns('PUT', `/${one}`, { model: 'c/d' });
      expect(restarts).toBe(2);
      runnerIs('cli');
      await conns('PUT', `/${one}`, { model: 'e/f' });
      expect(restarts).toBe(3);
      const keyless = await add({ provider: 'anthropic', model: 'claude-opus-5-5' });
      runnerIs('sdk');
      await call('PUT', OWNER, { route: keyless });
      expect(restarts).toBe(4);
    } finally {
      modelDeps.switchModel = undefined;
      rmSync(setupFile(), { force: true });
    }
  });
});
