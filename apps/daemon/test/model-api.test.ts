import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { forgetUsage, noteUsageHeaders } from '../src/gateway/usage.ts';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { handleModelRequest } from '../src/gateway/model-api.ts';
import { codexVersion, userAgent } from '../src/gateway/codex.ts';
import { ApiError } from '@metro-labs/http/api-error';
import type { ModelConfig } from '../src/gateway/model-config.ts';
import { auth, type Who } from './identity-helper.ts';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const OWNER = '0xef8305e140ac520225daf050e2f71d5fbcc543e7';
const STRANGER = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8';
const OTHER = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8';

let server: Server;
let issuer: Server;
let backend: Server;
let base = '';
let issuerBase = '';
let backendBase = '';
let stored: ModelConfig;
let home = '';
const seenModelUrls: string[] = [];
const creditsAuth: string[] = [];
const jwt = (claims: Record<string, unknown>): string => ['e30', Buffer.from(JSON.stringify(claims)).toString('base64url'), 'sig'].join('.');
const idToken = jwt({ email: 'less@example.com', 'https://api.openai.com/auth': { chatgpt_account_id: 'acct_1', chatgpt_plan_type: 'plus' } });

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'metro-codex-home-'));
  issuer = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    const url = req.url ?? '';
    if (url.endsWith('/deviceauth/usercode')) res.end(JSON.stringify({ device_auth_id: 'dev_1', user_code: 'ABCD-EFGH', interval: 1 }));
    else if (url.endsWith('/deviceauth/token')) res.end(JSON.stringify({ authorization_code: 'ac-1', code_challenge: 'ch', code_verifier: 'ver' }));
    else res.end(JSON.stringify({ id_token: idToken, access_token: 'at-1', refresh_token: 'rt-1' }));
  });
  await new Promise<void>((r) => {
    issuer.listen(0, '127.0.0.1', r);
  });
  issuerBase = `http://127.0.0.1:${String((issuer.address() as AddressInfo).port)}`;
  backend = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    if ((req.url ?? '').includes('/v1/models') && req.headers['x-api-key'] === undefined) {
      res.end(
        JSON.stringify({
          data: [
            { id: 'openai/gpt-5.2-codex', name: 'GPT-5.2 Codex', created: 1_760_000_000, pricing: { prompt: '0.00001', completion: '0.00005' } },
            { id: 'anthropic/claude-sonnet-4.5', name: 'Claude Sonnet 4.5', created: 1_700_000_000, pricing: { prompt: '0', completion: '-1' } },
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
    if (req.url === '/v1/credits') {
      creditsAuth.push(String(req.headers.authorization ?? ''));
      res.end(JSON.stringify({ data: { total_credits: 50, total_usage: 12.4 } }));
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
      if (ineligible.on) {
        res.end(JSON.stringify({ ineligibleTiers: [{ tierId: 'free-tier', reasonCode: 'DASHER_USER', reasonMessage: 'Your account is not eligible for Gemini Code Assist for individuals at this time' }] }));
        return;
      }
      if (managed.on) {
        res.end(JSON.stringify({ currentTier: { id: 'standard-tier', name: 'Standard' }, cloudaicompanionProject: '' }));
        return;
      }
      res.end(JSON.stringify({ allowedTiers: [{ id: 'legacy-tier' }, { id: 'free-tier', isDefault: true, name: 'Google AI Pro' }], cloudaicompanionProject: '' }));
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
    if (req.url === '/v1/endpoints/zdr') {
      res.end(JSON.stringify({ data: [{ model_id: 'openai/gpt-5.2-codex', provider_name: 'OpenAI' }, { model_id: 'anthropic/claude-sonnet-4.5' }, { model_id: 'anthropic/claude-sonnet-4.5' }, { name: 'no id' }] }));
      return;
    }
    seenModelUrls.push(req.url ?? '');
    res.end(JSON.stringify({ models: [{ slug: 'gpt-5.3-codex' }] }));
  });
  await new Promise<void>((r) => {
    backend.listen(0, '127.0.0.1', r);
  });
  backendBase = `http://127.0.0.1:${String((backend.address() as AddressInfo).port)}`;
  server = createServer((req, res) => {
    if (
      handleModelRequest(req, res, {
        authorize: (subject) => {
          if (subject !== OWNER) throw new ApiError('no such project', 404);
        },
        read: () => stored,
        write: (cfg) => {
          stored = cfg;
        },
        issuer: issuerBase,
        codexHome: home,
        codexBase: backendBase,
        openrouterBase: backendBase,
        anthropicBase: backendBase,
        bedrockControlBase: backendBase,
        geminiAuthBase: backendBase,
        geminiTokenBase: backendBase,
        geminiUserBase: backendBase,
        geminiBase: backendBase,
        setup: { dir: join(home, 'claude'), agents: join(home, 'agents') },
      })
    )
      return;
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
  creditsAuth.length = 0;
  googleForms.length = 0;
  stored = { version: 1, provider: 'anthropic', anthropic: { apiKey: '', model: '' }, bedrock: { region: '', apiKey: '', model: '' }, openrouter: { apiKey: '', model: '', zdr: false }, codex: { model: '', auth: null }, gemini: { model: '', auth: null } };
});

const call = async (method: string, who: Who | null, body?: unknown): Promise<Response> =>
  fetch(`${base}/api/model`, {
    method,
    headers: {
      ...(who === null ? {} : { authorization: await auth(method, '/api/model', who) }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

describe('the model route on the page', () => {
  test('the owner reads it without any key, and saves a route with its keys', async () => {
    const before = await call('GET', OWNER);
    expect(before.status).toBe(200);
    expect(await before.json()).toMatchObject({ provider: 'anthropic', ready: true, bedrock: { hasKey: false } });
    const saved = await call('PUT', OWNER, { provider: 'openrouter', openrouter: { apiKey: 'or-key', model: 'openai/gpt-5.2-codex' } });
    expect(saved.status).toBe(200);
    const body = await saved.json();
    expect(body).toMatchObject({ provider: 'openrouter', ready: true, openrouter: { model: 'openai/gpt-5.2-codex', hasKey: true } });
    expect(JSON.stringify(body)).not.toContain('or-key');
    expect(stored.openrouter.apiKey).toBe('or-key');
    const again = await call('PUT', OWNER, { openrouter: { model: 'anthropic/claude-sonnet-4.5', zdr: true } });
    expect(((await again.json()) as { openrouter: { hasKey: boolean; zdr: boolean } }).openrouter).toMatchObject({ hasKey: true, zdr: true });
    expect(stored.openrouter.model).toBe('anthropic/claude-sonnet-4.5');
    expect(stored.openrouter.zdr).toBe(true);
  });

  test('the settings carry what each provider last said about its quota, and OpenRouter credits are read once per five minutes', async () => {
    const quiet = (await (await call('GET', OWNER)).json()) as { usage: Record<string, unknown> };
    expect(quiet.usage).toEqual({});
    expect(creditsAuth).toEqual([]);

    noteUsageHeaders('codex', new Headers({ 'x-codex-primary-used-percent': '42', 'x-codex-primary-window-minutes': '300' }));
    stored = { ...stored, provider: 'openrouter', openrouter: { apiKey: 'or-key', model: 'x/y', zdr: false } };
    const first = (await (await call('GET', OWNER)).json()) as { usage: Record<string, { windows: { label: string; used: number | null; detail: string | null }[] }> };
    expect(first.usage.codex?.windows).toEqual([{ label: '5-hour window', used: 0.42, resetAt: null, detail: null }]);
    expect(first.usage.openrouter?.windows).toEqual([{ label: 'Credits', used: 0.248, resetAt: null, detail: '$12.40 of $50.00 used' }]);
    expect(creditsAuth).toEqual(['Bearer or-key']);
    expect(JSON.stringify(first)).not.toContain('or-key');

    await call('GET', OWNER);
    expect(creditsAuth).toHaveLength(1);
  });

  test('a bad body is a 400 naming the field, a stranger a 404, no signature a 401, other methods 405', async () => {
    const bad = await call('PUT', OWNER, { provider: 'mars' });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toContain('provider');
    expect((await call('GET', OTHER)).status).toBe(404);
    expect((await call('GET', null)).status).toBe(401);
    expect((await call('DELETE', OWNER)).status).toBe(405);
    expect(stored.provider).toBe('anthropic');
  });
});

const googleForms: URLSearchParams[] = [];
const ineligible = { on: false };
const managed = { on: false };
const onboardTiers: string[] = [];

const gemini = async (name: string, method: 'GET' | 'POST', body?: unknown): Promise<Response> =>
  fetch(`${base}/api/model/gemini/${name}`, {
    method,
    headers: {
      authorization: await auth(method, `/api/model/gemini/${name}`, OWNER),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const codex = async (name: string, method: 'GET' | 'POST', body?: unknown): Promise<Response> =>
  fetch(`${base}/api/model/codex/${name}`, {
    method,
    headers: {
      authorization: await auth(method, `/api/model/codex/${name}`, OWNER),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

describe('the model setup as a whole, for the export file', () => {
  test('the owner reads it with its keys and writes it back; anything else is refused', async () => {
    stored = { ...stored, provider: 'openrouter', openrouter: { apiKey: 'or-key', model: 'google/gemini-3.8-flash', zdr: true } };
    const bundle = await fetch(`${base}/api/model/bundle`, { headers: { authorization: await auth('GET', '/api/model/bundle', OWNER) } });
    expect(bundle.status).toBe(200);
    const body = (await bundle.json()) as ModelConfig;
    expect(body.openrouter).toEqual({ apiKey: 'or-key', model: 'google/gemini-3.8-flash', zdr: true });
    stored = { ...stored, provider: 'anthropic', openrouter: { apiKey: '', model: '', zdr: false } };
    const restored = await fetch(`${base}/api/model/restore`, {
      method: 'POST',
      headers: { authorization: await auth('POST', '/api/model/restore', OWNER), 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(restored.status).toBe(200);
    expect(await restored.json()).toMatchObject({ provider: 'openrouter', openrouter: { model: 'google/gemini-3.8-flash', hasKey: true, zdr: true } });
    expect(stored.openrouter.apiKey).toBe('or-key');
    const bad = await fetch(`${base}/api/model/restore`, {
      method: 'POST',
      headers: { authorization: await auth('POST', '/api/model/restore', OWNER), 'content-type': 'application/json' },
      body: '[]',
    });
    expect(bad.status).toBe(400);
    const stranger = await fetch(`${base}/api/model/bundle`, { headers: { authorization: await auth('GET', '/api/model/bundle', STRANGER) } });
    expect(stranger.status).not.toBe(200);
  });
});

describe('connecting ChatGPT for Codex from the page', () => {
  test('login hands back the authorize link, the pasted callback finishes it, and the tokens never reach the page', async () => {
    const started = (await (await codex('login', 'POST')).json()) as { url: string };
    const url = new URL(started.url);
    expect(url.searchParams.get('client_id')).toBe('app_EMoamEEZ73f0CkXaXp7hrann');
    const state = url.searchParams.get('state') ?? '';
    const stale = await codex('callback', 'POST', { url: 'http://localhost:1455/auth/callback?code=c&state=nope' });
    expect(stale.status).toBe(400);
    const done = await codex('callback', 'POST', { url: `http://localhost:1455/auth/callback?code=the-code&state=${state}` });
    expect(done.status).toBe(200);
    const shown = (await done.json()) as { codex: { signedIn: boolean; account: string | null; plan: string | null } };
    expect(shown.codex).toEqual({ model: '', signedIn: true, account: 'less@example.com', plan: 'plus' } as never);
    expect(JSON.stringify(shown)).not.toContain('at-1');
    expect(stored.codex.auth?.accessToken).toBe('at-1');
    const models = await codex('models', 'GET');
    expect(await models.json()).toEqual({ models: ['gpt-5.3-codex'] });
    const out = await codex('logout', 'POST');
    expect(((await out.json()) as { codex: { signedIn: boolean } }).codex.signedIn).toBe(false);
    expect(stored.codex.auth).toBeNull();
    expect((await codex('models', 'GET')).status).toBe(400);
  });

  test('the Codex CLI login on the box can be imported, and unknown codex routes are 404', async () => {
    expect((await codex('import', 'POST')).status).toBe(400);
    mkdirSync(join(home, '.codex'), { recursive: true });
    writeFileSync(join(home, '.codex', 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: { id_token: idToken, access_token: 'cli-at', refresh_token: 'cli-rt', account_id: 'acct_1' } }));
    const imported = await codex('import', 'POST');
    expect(imported.status).toBe(200);
    expect(stored.codex.auth?.accessToken).toBe('cli-at');
    expect((await codex('dance', 'POST')).status).toBe(404);
    expect((await codex('login', 'GET')).status).toBe(405);
  });
});

describe('connecting Google for Gemini from the page', () => {
  test('login hands back the Google link with PKCE, the pasted code finishes it after onboarding, and the tokens never reach the page', async () => {
    const started = (await (await gemini('login', 'POST')).json()) as { url: string; state: string };
    const url = new URL(started.url);
    expect(url.origin).toBe(backendBase);
    expect(url.pathname).toBe('/o/oauth2/v2/auth');
    expect(url.searchParams.get('client_id')).toBe('681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com');
    expect(url.searchParams.get('redirect_uri')).toBe('https://codeassist.google.com/authcode');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('state')).toBe(started.state);
    expect((await gemini('code', 'POST', { code: 'x', state: 'nope' })).status).toBe(400);
    const rejected = await gemini('code', 'POST', { code: 'bad-code', state: started.state });
    expect(rejected.status).toBe(400);
    expect(((await rejected.json()) as { error: string }).error).toContain('Bad Request');
    const again = (await (await gemini('login', 'POST')).json()) as { state: string };
    const done = await gemini('code', 'POST', { code: '4/0AbCdEf', state: again.state });
    expect(done.status).toBe(200);
    const shown = (await done.json()) as { gemini: Record<string, unknown> };
    expect(shown.gemini).toEqual({ model: '', signedIn: true, account: 'less@gmail.com', plan: 'Google AI Pro' });
    expect(JSON.stringify(shown)).not.toContain('g-at');
    expect(googleForms.at(-1)?.get('grant_type')).toBe('authorization_code');
    expect(googleForms.at(-1)?.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(stored.gemini.auth).toMatchObject({ accessToken: 'g-at', refreshToken: 'g-rt', project: 'managed-proj-7', tier: 'Google AI Pro', email: 'less@gmail.com' });
    expect(onboardTiers).toEqual(['free-tier']);
    expect(await (await gemini('models', 'GET')).json()).toMatchObject({ models: expect.arrayContaining(['gemini-2.5-pro']) as unknown });
    const out = await gemini('logout', 'POST');
    expect(((await out.json()) as { gemini: { signedIn: boolean } }).gemini.signedIn).toBe(false);
    expect(stored.gemini.auth).toBeNull();
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
      expect(stored.gemini.auth).toBeNull();
    } finally {
      ineligible.on = false;
    }
  });

  test('an account with a tier but no project is a managed one, refused by name rather than onboarded blind', async () => {
    managed.on = true;
    try {
      const started = (await (await gemini('login', 'POST')).json()) as { state: string };
      const refused = await gemini('code', 'POST', { code: '4/ok', state: started.state });
      expect(refused.status).toBe(400);
      expect(((await refused.json()) as { error: string }).error).toContain('managed (Workspace)');
      expect(stored.gemini.auth).toBeNull();
    } finally {
      managed.on = false;
    }
  });
});

describe('the device-code sign-in from the page', () => {
  test('a code is issued, the page polls, and the tokens land in the model file', async () => {
    const started = await codex('device', 'POST');
    expect(started.status).toBe(200);
    const login = (await started.json()) as { id: string; user_code: string; verify_url: string; interval: number };
    expect(login).toMatchObject({ user_code: 'ABCD-EFGH', verify_url: `${issuerBase}/codex/device`, interval: 1 });
    const done = await codex(`device/${login.id}`, 'GET');
    expect(done.status).toBe(200);
    expect(await done.json()).toMatchObject({ status: 'done', settings: { codex: { signedIn: true, account: 'less@example.com', plan: 'plus' } } });
    expect(stored.codex.auth?.accessToken).toBe('at-1');
    expect((await codex(`device/${login.id}`, 'GET')).status).toBe(400);
    expect((await codex('device/short', 'GET')).status).toBe(404);
    expect((await codex(`device/${login.id}`, 'POST')).status).toBe(405);
  });
});

describe('picking an OpenRouter model without typing its id', () => {
  test('the daemon lists what OpenRouter serves newest first, dropping rows with no id', async () => {
    const res = await fetch(`${base}/api/model/openrouter/models`, {
      headers: { authorization: await auth('GET', '/api/model/openrouter/models', OWNER) },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      models: [
        { id: 'openai/gpt-5.2-codex', name: 'GPT-5.2 Codex', prompt: 0.00001, completion: 0.00005, created: 1_760_000_000 },
        { id: 'anthropic/claude-sonnet-4.5', name: 'Claude Sonnet 4.5', prompt: 0, completion: null, created: 1_700_000_000 },
      ],
    });
    const stranger = await fetch(`${base}/api/model/openrouter/models`, {
      headers: { authorization: await auth('GET', '/api/model/openrouter/models', OTHER) },
    });
    expect(stranger.status).toBe(404);
    const wrong = await fetch(`${base}/api/model/openrouter/nope`, {
      headers: { authorization: await auth('GET', '/api/model/openrouter/nope', OWNER) },
    });
    expect(wrong.status).toBe(404);
  });
});

describe('the Codex client version metro announces', () => {
  test('is a current one, so the backend offers the models a current client may use, and it can be overridden', async () => {
    seenModelUrls.length = 0;
    stored.codex.auth = { accessToken: 'at-1', refreshToken: 'rt-1', idToken, accountId: 'acct_1', email: null, plan: 'pro', savedAt: new Date().toISOString() };
    await codex('models', 'GET');
    expect(seenModelUrls.at(-1)).toContain('client_version=0.153.4');
    expect(codexVersion()).toBe('0.153.4');
    process.env.METRO_CODEX_VERSION = '0.160.0';
    await codex('models', 'GET');
    expect(seenModelUrls.at(-1)).toContain('client_version=0.160.0');
    expect(userAgent()).toContain('codex_cli_rs/0.160.0');
    process.env.METRO_CODEX_VERSION = 'not a version';
    expect(codexVersion()).toBe('0.153.4');
    delete process.env.METRO_CODEX_VERSION;
    stored.codex.auth = null;
  });
});

describe('zero data retention on OpenRouter', () => {
  test('the daemon lists the models with a zero data retention endpoint, once each, sorted', async () => {
    const res = await fetch(`${base}/api/model/openrouter/zdr`, {
      headers: { authorization: await auth('GET', '/api/model/openrouter/zdr', OWNER) },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ models: ['anthropic/claude-sonnet-4.5', 'openai/gpt-5.2-codex'] });
  });
});

describe('picking an Anthropic or Bedrock model without typing its id', () => {
  test('Anthropic lists the known Claude models without a key, and the account list with one', async () => {
    const res = await fetch(`${base}/api/model/anthropic/models`, { headers: { authorization: await auth('GET', '/api/model/anthropic/models', OWNER) } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { models: { id: string }[] }).models.map((m) => m.id)).toContain('claude-sonnet-5');
    stored = { ...stored, anthropic: { apiKey: 'sk-ant', model: '' } };
    const live = await fetch(`${base}/api/model/anthropic/models`, { headers: { authorization: await auth('GET', '/api/model/anthropic/models', OWNER) } });
    expect(await live.json()).toEqual({ models: [{ id: 'claude-opus-5', name: 'Claude Opus 5' }, { id: 'claude-sonnet-5', name: 'Claude Sonnet 5' }] });
  });

  test('Bedrock lists the active Anthropic inference profiles of the region, and says why when it cannot', async () => {
    const refused = await fetch(`${base}/api/model/bedrock/models`, { headers: { authorization: await auth('GET', '/api/model/bedrock/models', OWNER) } });
    expect(refused.status).toBe(400);
    stored = { ...stored, bedrock: { region: 'eu-central-1', apiKey: 'aws-key', model: '' } };
    const res = await fetch(`${base}/api/model/bedrock/models`, { headers: { authorization: await auth('GET', '/api/model/bedrock/models', OWNER) } });
    expect(await res.json()).toEqual({ models: [{ id: 'eu.anthropic.claude-sonnet-5', name: 'EU Claude Sonnet 5' }] });
  });

  test('saving a non-Anthropic route writes the Claude Code model allowlist, and saving Anthropic back removes it', async () => {
    await call('PUT', OWNER, { provider: 'openrouter', openrouter: { apiKey: 'or-key', model: 'anthropic/claude-sonnet-5' } });
    const settingsPath = join(home, 'claude', 'settings.json');
    expect(JSON.parse(readFileSync(settingsPath, 'utf8'))).toMatchObject({ availableModels: ['openrouter:anthropic/claude-sonnet-5'], enforceAvailableModels: true });
    await call('PUT', OWNER, { provider: 'anthropic' });
    expect(JSON.parse(readFileSync(settingsPath, 'utf8'))).not.toHaveProperty('availableModels');
  });
});
