import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { handleModelRequest } from '../src/daemon/model-api.ts';
import { codexVersion, userAgent } from '../src/gateway/codex.ts';
import { ApiError } from '../src/daemon/api-error.ts';
import type { ModelConfig } from '../src/gateway/model-config.ts';
import { auth, type Who } from './identity-helper.ts';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const OWNER = '0xef8305e140ac520225daf050e2f71d5fbcc543e7';
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
    if ((req.url ?? '').includes('/v1/models')) {
      res.end(
        JSON.stringify({
          data: [
            { id: 'openai/gpt-5.2-codex', name: 'GPT-5.2 Codex', pricing: { prompt: '0.00001', completion: '0.00005' } },
            { id: 'anthropic/claude-sonnet-4.5', name: 'Claude Sonnet 4.5', pricing: { prompt: '0', completion: '-1' } },
            { name: 'no id' },
            7,
          ],
        }),
      );
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
  stored = { version: 1, provider: 'anthropic', bedrock: { region: '', apiKey: '', model: '' }, openrouter: { apiKey: '', model: '' }, codex: { model: '', auth: null } };
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
    const again = await call('PUT', OWNER, { openrouter: { model: 'anthropic/claude-sonnet-4.5' } });
    expect(((await again.json()) as { openrouter: { hasKey: boolean } }).openrouter.hasKey).toBe(true);
    expect(stored.openrouter.model).toBe('anthropic/claude-sonnet-4.5');
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

const codex = async (name: string, method: 'GET' | 'POST', body?: unknown): Promise<Response> =>
  fetch(`${base}/api/model/codex/${name}`, {
    method,
    headers: {
      authorization: await auth(method, `/api/model/codex/${name}`, OWNER),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
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
  test('the daemon lists what OpenRouter serves, sorted, dropping rows with no id', async () => {
    const res = await fetch(`${base}/api/model/openrouter/models`, {
      headers: { authorization: await auth('GET', '/api/model/openrouter/models', OWNER) },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      models: [
        { id: 'anthropic/claude-sonnet-4.5', name: 'Claude Sonnet 4.5', prompt: 0, completion: null },
        { id: 'openai/gpt-5.2-codex', name: 'GPT-5.2 Codex', prompt: 0.00001, completion: 0.00005 },
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
