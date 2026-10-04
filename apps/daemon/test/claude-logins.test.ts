import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { handleClaudeRequest } from '../src/claude/api.ts';
import { forgetClaudeLogin } from '../src/claude/login.ts';
import { handleGatewayRequest, resetGatewayState } from '../src/gateway/gateway.ts';
import { handleModelRequest } from '../src/gateway/model-api.ts';
import { parseModelConfig, type Connection, type ModelConfig } from '../src/gateway/model-config.ts';
import { forgetUsage, usageSeen } from '../src/gateway/usage.ts';
import { auth } from './identity-helper.ts';
import { makeConnection } from './model-fixture.ts';

const OWNER = '0xef8305e140ac520225daf050e2f71d5fbcc543e7';
const FAR = 4_102_444_800_000;
const LOGIN =
  'printf "Open https://claude.ai/oauth/authorize?x=1 in a browser\\n"; read code; [ "$code" = fail ] && exit 3; ' +
  'mkdir -p "$CLAUDE_CONFIG_DIR"; printf "%s@example.com" "$code" > "$CLAUDE_CONFIG_DIR/who"; ' +
  `printf '{"claudeAiOauth":{"accessToken":"tok-%s","refreshToken":"rt-%s","expiresAt":${String(FAR)}}}' "$code" "$code" > "$CLAUDE_CONFIG_DIR/.credentials.json"; exit 0`;

interface View {
  id: string;
  state: string;
  url: string | null;
  error: string | null;
}

interface Seen {
  auth: string;
  beta: string;
  apiKey: string | null;
  metroKey: string | null;
}

const root = mkdtempSync(join(tmpdir(), 'metro-claude-logins-'));
const logins = join(root, 'logins');
const priorConfigDir = process.env.CLAUDE_CONFIG_DIR;
let stored: ModelConfig = { version: 2, route: '', connections: [] };
let base = '';
let server: Server;
let upstream: Server;
const seen: Seen[] = [];
const probed: string[] = [];
const refused = new Set<string>();
let renewTo: string | null = null;

const writeTokens = (dir: string, token: string, expiresAt = FAR): void => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: token, refreshToken: `rt-${token}`, expiresAt } }));
};

const tokenIn = (dir: string): string => (JSON.parse(readFileSync(join(dir, '.credentials.json'), 'utf8')) as { claudeAiOauth: { accessToken: string } }).claudeAiOauth.accessToken;

const probe = (env?: Record<string, string>): Promise<unknown> => {
  const dir = env?.CLAUDE_CONFIG_DIR ?? 'machine';
  probed.push(dir);
  if (renewTo !== null && dir !== 'machine') writeTokens(dir, renewTo);
  const share = dir === 'machine' ? 5 : existsSync(join(dir, 'who')) ? readFileSync(join(dir, 'who'), 'utf8').length : 1;
  return Promise.resolve({ five_hour: { utilization: share, resets_at: null } });
};

const account = (env: Record<string, string>): { signedIn: boolean; account: string | null; plan: string | null } => {
  const who = join(env.CLAUDE_CONFIG_DIR ?? '', 'who');
  return existsSync(who) ? { signedIn: true, account: readFileSync(who, 'utf8'), plan: 'max' } : { signedIn: false, account: null, plan: null };
};

const store = {
  read: () => stored,
  write: (cfg: ModelConfig) => {
    stored = cfg;
  },
};

beforeAll(async () => {
  process.env.CLAUDE_CONFIG_DIR = join(root, 'machine');
  upstream = createServer((req: IncomingMessage, res: ServerResponse) => {
    req.resume();
    req.on('end', () => {
      const header = (name: string): string | null => {
        const value = req.headers[name];
        return typeof value === 'string' ? value : null;
      };
      const entry = { auth: header('authorization') ?? '', beta: header('anthropic-beta') ?? '', apiKey: header('x-api-key'), metroKey: header('x-metro-key') };
      if ((req.url ?? '').endsWith('/messages')) seen.push(entry);
      const token = entry.auth.replace('Bearer ', '');
      if (refused.has(token)) {
        res.writeHead(401, { 'content-type': 'application/json' }).end('{"type":"error","error":{"type":"authentication_error","message":"bad token"}}');
        return;
      }
      const used = String((token.length % 10) / 10);
      res.writeHead(200, { 'content-type': 'application/json', 'anthropic-ratelimit-unified-5h-utilization': used });
      res.end(JSON.stringify({ type: 'message', content: [] }));
    });
  });
  await new Promise<void>((r) => {
    upstream.listen(0, '127.0.0.1', r);
  });
  const upstreamBase = `http://127.0.0.1:${String((upstream.address() as AddressInfo).port)}`;
  server = createServer((req, res) => {
    if (handleClaudeRequest(req, res, { login: { command: ['sh', '-c', LOGIN] }, claudeLogins: { root: logins, account, probe, ...store } })) return;
    const model = { ...store, claudeUsage: probe, claudeLoginsRoot: logins, anthropicBase: upstreamBase, openrouterBase: upstreamBase, usageWaitMs: 2_000 };
    if (handleModelRequest(req, res, { ...model, setup: { dir: join(root, 'machine'), agents: join(root, 'agents') }, restartSession: () => false })) return;
    if (handleGatewayRequest(req, res, { config: () => stored, identify: (key) => key === 'mk_ok', anthropicBase: upstreamBase, openrouterBase: upstreamBase, claudeLogins: { root: logins, probe } })) return;
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => {
    server.listen(0, '127.0.0.1', r);
  });
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

afterAll(() => {
  if (priorConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = priorConfigDir;
  forgetClaudeLogin();
  server.close();
  upstream.close();
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  resetGatewayState();
  forgetUsage();
  seen.length = 0;
  probed.length = 0;
  refused.clear();
  renewTo = null;
});

const call = async (method: string, path: string, body?: unknown): Promise<Response> =>
  fetch(`${base}${path}`, {
    method,
    headers: { authorization: await auth(OWNER), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const viewOf = async (path: string): Promise<View> => (await (await call('GET', path)).json()) as View;

async function until(check: () => Promise<boolean>, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('the sign-in never got there');
}

async function signIn(connection: string, code: string): Promise<View> {
  const started = (await (await call('POST', `/api/claude/login?connection=${connection}`)).json()) as View;
  const path = `/api/claude/login/${started.id}`;
  await until(async () => (await viewOf(path)).url !== null);
  await call('POST', path, { text: code });
  await until(async () => (await viewOf(path)).state !== 'pending');
  return viewOf(path);
}

const own = (): Connection[] => stored.connections.filter((c) => c.claude !== null);
const dirOf = (c: Connection | undefined): string => join(logins, c?.claude?.id ?? 'none');

async function ask(connection: string, sessionAuth = 'Bearer machine-login'): Promise<Response> {
  stored = { ...stored, route: connection };
  return fetch(`${base}/gateway/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-metro-key': 'mk_ok', authorization: sessionAuth, 'anthropic-beta': 'fine-grained-tool-streaming-2025-05-14' },
    body: JSON.stringify({ model: 'claude-opus-5-5', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }),
  });
}

describe('several Claude subscriptions on one box', () => {
  test('each sign-in becomes its own connection with its own login folder and email, and the first one is left alone', async () => {
    expect((await signIn('new', 'alice')).state).toBe('done');
    const [alice] = own();
    expect(alice?.provider).toBe('anthropic');
    expect(alice?.claude?.email).toBe('alice@example.com');
    const before = structuredClone(alice);
    expect((await signIn('new', 'bob')).state).toBe('done');
    const [first, bob] = own();
    expect(first).toEqual(before as Connection);
    expect(bob?.claude?.email).toBe('bob@example.com');
    expect(bob?.claude?.id).not.toBe(first?.claude?.id);
    expect(tokenIn(dirOf(first))).toBe('tok-alice');
    expect(tokenIn(dirOf(bob))).toBe('tok-bob');
    const page = (await (await call('GET', '/api/model')).json()) as { connections: { id: string; account: string | null; signedIn: boolean; label: string }[] };
    expect(page.connections.map((c) => [c.account, c.signedIn])).toEqual([
      ['alice@example.com', true],
      ['bob@example.com', true],
    ]);
    expect(page.connections[0]?.label).not.toBe(page.connections[1]?.label);
    expect(JSON.stringify(page)).not.toContain('tok-');
  }, 20_000);

  test('signing one connection in again replaces only its login; a failed or unknown sign-in changes nothing', async () => {
    const [alice, bob] = own();
    const bobBefore = structuredClone(bob);
    const failed = await signIn(alice?.id ?? '', 'fail');
    expect(failed.state).toBe('failed');
    expect(own()[0]).toEqual(alice as Connection);
    expect(readdirSync(logins).sort()).toEqual([alice?.claude?.id, bob?.claude?.id].sort());
    expect((await signIn(alice?.id ?? '', 'carol')).state).toBe('done');
    const [carol, stillBob] = own();
    expect(carol?.id).toBe(alice?.id);
    expect(carol?.claude?.email).toBe('carol@example.com');
    expect(existsSync(dirOf(alice))).toBe(false);
    expect(tokenIn(dirOf(carol))).toBe('tok-carol');
    expect(stillBob).toEqual(bobBefore as Connection);
    expect((await call('POST', '/api/claude/login?connection=no-such-one')).status).toBe(404);
  }, 20_000);

  test('the gateway sends each connection with its own token, even when the session has no login of its own', async () => {
    const [carol, bob] = own();
    expect((await ask(carol?.id ?? '')).status).toBe(200);
    expect((await ask(bob?.id ?? '', 'Bearer mk_ok')).status).toBe(200);
    expect(seen.map((s) => s.auth)).toEqual(['Bearer tok-carol', 'Bearer tok-bob']);
    for (const s of seen) {
      expect(s.beta.split(',')).toContain('oauth-2025-04-20');
      expect(s.apiKey).toBeNull();
      expect(s.metroKey).toBeNull();
    }
    const usage = usageSeen();
    expect(usage[carol?.id ?? '']?.windows[0]?.used).toBe(0.9);
    expect(usage[bob?.id ?? '']?.windows[0]?.used).toBe(0.7);
  });

  test('a stale token is renewed by Claude Code in that login folder only, and a refused one is renewed once then retried', async () => {
    const [carol, bob] = own();
    writeTokens(dirOf(carol), 'tok-old', Date.now() - 1_000);
    renewTo = 'tok-renewed';
    expect((await ask(carol?.id ?? '')).status).toBe(200);
    expect(probed).toEqual([dirOf(carol)]);
    expect(seen.at(-1)?.auth).toBe('Bearer tok-renewed');
    expect(tokenIn(dirOf(bob))).toBe('tok-bob');

    probed.length = 0;
    refused.add('tok-renewed');
    renewTo = 'tok-again';
    expect((await ask(carol?.id ?? '')).status).toBe(200);
    expect(probed).toEqual([dirOf(carol)]);
    expect(seen.slice(-2).map((s) => s.auth)).toEqual(['Bearer tok-renewed', 'Bearer tok-again']);

    refused.add('tok-again');
    renewTo = null;
    const stuck = await ask(carol?.id ?? '');
    expect(stuck.status).toBe(403);
    expect(await stuck.text()).toContain('sign in again on the Model page');
    expect(tokenIn(dirOf(bob))).toBe('tok-bob');
    writeTokens(dirOf(carol), 'tok-carol');
  });

  test('the usage of each login is asked of Claude Code in that login folder, and kept apart', async () => {
    const [carol, bob] = own();
    const page = (await (await call('GET', '/api/model')).json()) as { usage: Record<string, { windows: { used: number }[] }> };
    expect(probed.sort()).toEqual([dirOf(carol), dirOf(bob)].sort());
    expect(page.usage[carol?.id ?? '']?.windows[0]?.used).toBe(0.17);
    expect(page.usage[bob?.id ?? '']?.windows[0]?.used).toBe(0.15);
  });

  test('removing one connection removes its login folder only, and the other keeps working', async () => {
    const [carol, bob] = own();
    expect((await call('DELETE', `/api/model/connections/${carol?.id ?? ''}`)).status).toBe(200);
    expect(existsSync(dirOf(carol))).toBe(false);
    expect(own()).toEqual([bob as Connection]);
    expect((await ask(bob?.id ?? '')).status).toBe(200);
    expect(seen.at(-1)?.auth).toBe('Bearer tok-bob');
  });
});

describe('connections from before, and the providers that use keys', () => {
  test('a keyless Anthropic connection saved before keeps riding the session login, and a bad login reference is dropped', async () => {
    const legacy = parseModelConfig({
      version: 2,
      route: 'old-1',
      connections: [
        { id: 'old-1', provider: 'anthropic', label: 'Anthropic' },
        { id: 'old-2', provider: 'anthropic', label: 'Anthropic 2', claude: { id: '../../escape', email: 'x@example.com' } },
        { id: 'old-3', provider: 'openrouter', label: 'OpenRouter', apiKey: 'or-1', claude: { id: 'AAAAAAAAAAA' } },
      ],
    });
    expect(legacy.connections.map((c) => c.claude)).toEqual([null, null, null]);
    stored = legacy;
    expect((await ask('old-2')).status).toBe(200);
    expect(seen.at(-1)?.auth).toBe('Bearer machine-login');
    const page = (await (await call('GET', '/api/model')).json()) as { usage: Record<string, unknown> };
    expect(probed).toEqual(['machine']);
    expect(Object.keys(page.usage).sort()).toEqual(['old-1', 'old-2']);
  });

  test('two keys of one provider stay two connections, each request carries its own key, and removing one keeps the other', async () => {
    stored = {
      version: 2,
      route: 'a-1',
      connections: [
        makeConnection('anthropic', { id: 'a-1', apiKey: 'sk-one' }),
        makeConnection('anthropic', { id: 'a-2', apiKey: 'sk-two' }),
        makeConnection('openrouter', { id: 'o-1', apiKey: 'or-one', model: 'x/y' }),
        makeConnection('openrouter', { id: 'o-2', apiKey: 'or-two', model: 'x/y' }),
      ],
    };
    for (const id of ['a-1', 'a-2', 'o-1', 'o-2']) await ask(id);
    expect(seen.map((s) => s.apiKey ?? s.auth)).toEqual(['sk-one', 'sk-two', 'Bearer or-one', 'Bearer or-two']);
    expect((await call('DELETE', '/api/model/connections/a-1')).status).toBe(200);
    expect((await call('DELETE', '/api/model/connections/o-2')).status).toBe(200);
    expect(stored.connections.map((c) => [c.id, c.apiKey])).toEqual([
      ['a-2', 'sk-two'],
      ['o-1', 'or-one'],
    ]);
    await ask('a-2');
    await ask('o-1');
    expect(seen.slice(-2).map((s) => s.apiKey ?? s.auth)).toEqual(['sk-two', 'Bearer or-one']);
  });
});
