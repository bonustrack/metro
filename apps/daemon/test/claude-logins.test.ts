import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { handleClaudeRequest } from '../src/claude/api.ts';
import { forgetClaudeLogin } from '../src/claude/login.ts';
import { readClaudeLogins, type ClaudeLogin } from '../src/gateway/claude-store.ts';
import { setupOf } from '../src/gateway/effective.ts';
import { handleGatewayRequest, resetGatewayState } from '../src/gateway/gateway.ts';
import { handleModelRequest } from '../src/gateway/model-api.ts';
import { emptySetup, type ModelSetup } from '../src/gateway/model-config.ts';
import { forgetUsage, usageSeen } from '../src/gateway/usage.ts';
import { auth } from './identity-helper.ts';

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
const agents = join(root, 'agents');
const priorConfigDir = process.env.CLAUDE_CONFIG_DIR;
let setup: ModelSetup = emptySetup();
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

beforeAll(async () => {
  process.env.CLAUDE_CONFIG_DIR = join(root, 'machine');
  mkdirSync(agents, { recursive: true });
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
      res.end(JSON.stringify({ type: 'message', content: [], data: [] }));
    });
  });
  await new Promise<void>((r) => {
    upstream.listen(0, '127.0.0.1', r);
  });
  const upstreamBase = `http://127.0.0.1:${String((upstream.address() as AddressInfo).port)}`;
  const claudeLogins = { root: logins, account, probe, dir: agents };
  server = createServer((req, res) => {
    if (handleClaudeRequest(req, res, { login: { command: ['sh', '-c', LOGIN] }, claudeLogins })) return;
    if (handleModelRequest(req, res, { dir: () => agents, setup: () => setup, claudeUsage: probe, claudeLogins, anthropicBase: upstreamBase, openrouterBase: upstreamBase, usageWaitMs: 2_000 })) return;
    if (handleGatewayRequest(req, res, { setup: () => setup, identify: (key) => key === 'mk_ok', anthropicBase: upstreamBase, openrouterBase: upstreamBase, claudeLogins })) return;
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
  setup = emptySetup();
});

const call = async (method: string, path: string, body?: unknown, role: 'admin' | 'member' = 'admin'): Promise<Response> =>
  fetch(`${base}${path}`, {
    method,
    headers: { authorization: await auth(OWNER, role), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
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

const own = (): ClaudeLogin[] => readClaudeLogins(agents);
const dirOf = (login: ClaudeLogin | undefined): string => join(logins, login?.id ?? 'none');

async function ask(login: string, sessionAuth = 'Bearer machine-login'): Promise<Response> {
  setup = setupOf({ route: { primary: { connection: `local:${login}`, model: '' }, fallbacks: [] }, source: 'agent', connections: [] }, own());
  return fetch(`${base}/gateway/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-metro-key': 'mk_ok', authorization: sessionAuth, 'anthropic-beta': 'fine-grained-tool-streaming-2025-05-14' },
    body: JSON.stringify({ model: 'claude-opus-5-5', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }),
  });
}

describe('several Claude subscriptions on one box', () => {
  test('each sign-in is kept in model.json v3 with its own login folder and email, and the first one is left alone', async () => {
    expect((await signIn('new', 'alice')).state).toBe('done');
    const [alice] = own();
    expect(alice?.email).toBe('alice@example.com');
    const before = structuredClone(alice);
    expect((await signIn('new', 'bob')).state).toBe('done');
    const [first, bob] = own();
    expect(first).toEqual(before as ClaudeLogin);
    expect(bob?.email).toBe('bob@example.com');
    expect(bob?.id).not.toBe(first?.id);
    expect(tokenIn(dirOf(first))).toBe('tok-alice');
    expect(tokenIn(dirOf(bob))).toBe('tok-bob');
    expect(JSON.parse(readFileSync(join(agents, 'model.json'), 'utf8'))).toEqual({ version: 3, claude: own() });
    expect(statSync(join(agents, 'model.json')).mode & 0o777).toBe(0o600);
    const page = (await (await call('GET', '/api/model')).json()) as { claude: ClaudeLogin[] };
    expect(page.claude.map((c) => [c.id, c.email, c.plan])).toEqual([
      [first?.id, 'alice@example.com', 'max'],
      [bob?.id, 'bob@example.com', 'max'],
    ]);
    expect(JSON.stringify(page)).not.toContain('tok-');
  }, 20_000);

  test('signing one login in again keeps its id and replaces only its folder; a failed or unknown sign-in changes nothing', async () => {
    const [alice, bob] = own();
    const bobBefore = structuredClone(bob);
    const failed = await signIn(alice?.id ?? '', 'fail');
    expect(failed.state).toBe('failed');
    expect(own()[0]).toEqual(alice as ClaudeLogin);
    expect(readdirSync(logins).sort()).toEqual([alice?.id, bob?.id].sort());
    expect((await signIn(alice?.id ?? '', 'carol')).state).toBe('done');
    const [carol, stillBob] = own();
    expect(carol?.id).toBe(alice?.id);
    expect(carol?.email).toBe('carol@example.com');
    expect(tokenIn(dirOf(carol))).toBe('tok-carol');
    expect(readdirSync(logins).sort()).toEqual([alice?.id, bob?.id].sort());
    expect(stillBob).toEqual(bobBefore as ClaudeLogin);
    expect((await call('POST', '/api/claude/login?connection=no-such-one')).status).toBe(404);
  }, 20_000);

  test('the gateway sends each local:<login> route with its own token, even when the session has no login of its own', async () => {
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
    expect(usage[`local:${carol?.id ?? ''}`]?.windows[0]?.used).toBe(0.9);
    expect(usage[`local:${bob?.id ?? ''}`]?.windows[0]?.used).toBe(0.7);
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

  test('the usage of each login is asked of Claude Code in that login folder, and kept apart under local:<login>', async () => {
    const [carol, bob] = own();
    const page = (await (await call('GET', '/api/model')).json()) as { usage: Record<string, { windows: { used: number }[] }> };
    expect(probed.filter((p) => p !== 'machine').sort()).toEqual([dirOf(carol), dirOf(bob)].sort());
    expect(page.usage[`local:${carol?.id ?? ''}`]?.windows[0]?.used).toBe(0.17);
    expect(page.usage[`local:${bob?.id ?? ''}`]?.windows[0]?.used).toBe(0.15);
    expect(page.usage['local:session']?.windows[0]?.used).toBe(0.05);
  });

  test('removing one login takes an admin, removes its folder only, and the other keeps working', async () => {
    const [carol, bob] = own();
    expect((await call('DELETE', `/api/model/claude/${carol?.id ?? ''}`, undefined, 'member')).status).toBe(403);
    expect((await call('DELETE', `/api/model/claude/${carol?.id ?? ''}`)).status).toBe(200);
    expect((await call('DELETE', `/api/model/claude/${carol?.id ?? ''}`)).status).toBe(404);
    expect(existsSync(dirOf(carol))).toBe(false);
    expect(own()).toEqual([bob as ClaudeLogin]);
    expect((await ask(bob?.id ?? '')).status).toBe(200);
    expect(seen.at(-1)?.auth).toBe('Bearer tok-bob');
    const gone = await ask(carol?.id ?? '');
    expect(gone.status).toBe(400);
    expect(await gone.text()).toContain('not on this box');
  });
});

describe('a box whose model.json is still the old version 2', () => {
  test('a new login writes version 3 with the logins it held, and a bad login reference is never read', async () => {
    const [bob] = own();
    const v2 = {
      version: 2,
      route: 'old-or',
      connections: [
        { id: 'old-or', provider: 'openrouter', label: 'OpenRouter', apiKey: 'or-1', model: 'x/y' },
        { id: 'old-bob', provider: 'anthropic', label: 'Bob', claude: bob },
        { id: 'old-bad', provider: 'anthropic', label: 'Bad', claude: { id: '../../escape', email: 'x@example.com' } },
      ],
    };
    writeFileSync(join(agents, 'model.json'), JSON.stringify(v2));
    expect(own()).toEqual([bob as ClaudeLogin]);
    expect((await signIn('new', 'dave')).state).toBe('done');
    const file = JSON.parse(readFileSync(join(agents, 'model.json'), 'utf8')) as { version: number; claude: { email: string }[] };
    expect(file.version).toBe(3);
    expect(file.claude.map((l) => l.email)).toEqual(['bob@example.com', 'dave@example.com']);
    expect(readFileSync(join(agents, 'model.json'), 'utf8')).not.toContain('or-1');
    expect(own().map((l) => l.email)).toEqual(['bob@example.com', 'dave@example.com']);
  }, 20_000);
});
