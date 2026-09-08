import { afterEach, describe, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { handleClaudeRequest } from '../src/daemon/claude-api.js';
import { ApiError } from '../src/daemon/api-error.js';
import { forgetClaudeLogin, loginUrlIn, plainText } from '../src/daemon/claude-login.js';
import { auth } from './identity-helper.ts';

const OWNER = '0xef8305e140ac520225daf050e2f71d5fbcc543e7';
const STRANGER = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8';
const ESC = String.fromCharCode(27);
const SCRIPT =
  'printf "Open \\033[1mhttps://claude.ai/oauth/authorize?code=1\\033[0m in a browser\\n"; read code; test "$code" = "the-code" && exit 0; exit 3';

interface View {
  id: string;
  state: string;
  url: string | null;
  output: string;
  error: string | null;
}

let server: Server;
let base = '';

async function start(command: string[]): Promise<string> {
  server = createServer((req, res) => {
    const deps = {
      authorize: (subject: string) => {
        if (subject !== OWNER) throw new ApiError('no such project', 404);
      },
      login: { command },
    };
    if (handleClaudeRequest(req, res, deps)) return;
    res.writeHead(404).end();
  });
  await new Promise<void>((done) => {
    server.listen(0, '127.0.0.1', done);
  });
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  return base;
}

const call = async (method: string, path: string, body?: unknown, who = OWNER): Promise<Response> =>
  fetch(`${base}${path}`, {
    method,
    headers: { authorization: await auth(method, path, who), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

async function until(check: () => Promise<boolean>, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('the login never got there');
}

afterEach(() => {
  forgetClaudeLogin();
  server.close();
});

describe('signing Claude Code in from the page, by driving its own login', () => {
  test('the url it prints is surfaced, the pasted code goes back in, and the exit decides the verdict', async () => {
    await start(['sh', '-c', SCRIPT]);
    const started = (await (await call('POST', '/api/claude/login')).json()) as View;
    expect(started.state).toBe('pending');
    expect(started.id).toBeTruthy();
    const path = `/api/claude/login/${started.id}`;
    await until(async () => ((await (await call('GET', path)).json()) as View).url !== null);
    const waiting = (await (await call('GET', path)).json()) as View;
    expect(waiting.url).toBe('https://claude.ai/oauth/authorize?code=1');
    expect(waiting.output).toContain('in a browser');
    expect(waiting.output).not.toContain(ESC);
    expect((await call('POST', path, { text: 'the-code' })).status).toBe(200);
    await until(async () => ((await (await call('GET', path)).json()) as View).state !== 'pending');
    expect(((await (await call('GET', path)).json()) as View).state).toBe('done');
  }, 20_000);

  test('a login that ends badly says so, and a wrong code is a failure not a hang', async () => {
    await start(['sh', '-c', SCRIPT]);
    const started = (await (await call('POST', '/api/claude/login')).json()) as View;
    const path = `/api/claude/login/${started.id}`;
    await until(async () => ((await (await call('GET', path)).json()) as View).url !== null);
    await call('POST', path, { text: 'wrong' });
    await until(async () => ((await (await call('GET', path)).json()) as View).state !== 'pending');
    const ended = (await (await call('GET', path)).json()) as View;
    expect(ended.state).toBe('failed');
    expect(ended.error).toContain('status 3');
    expect((await call('POST', path, { text: 'again' })).status).toBe(409);
  }, 20_000);

  test('only the owner may drive it, a stale id is a 404, and the body must carry text', async () => {
    await start(['sh', '-c', SCRIPT]);
    expect((await call('POST', '/api/claude/login', undefined, STRANGER)).status).toBe(404);
    const started = (await (await call('POST', '/api/claude/login')).json()) as View;
    const path = `/api/claude/login/${started.id}`;
    expect((await call('POST', path, { nope: 1 })).status).toBe(400);
    expect((await call('GET', '/api/claude/login/made-up')).status).toBe(404);
    expect((await call('PUT', path, { text: 'x' })).status).toBe(405);
    expect((await call('DELETE', path)).status).toBe(200);
    expect((await call('GET', path)).status).toBe(404);
  }, 20_000);

  test('a second start hands back the sign-in already running, not a new one', async () => {
    await start(['sh', '-c', SCRIPT]);
    const first = (await (await call('POST', '/api/claude/login')).json()) as View;
    const second = (await (await call('POST', '/api/claude/login')).json()) as View;
    expect(second.id).toBe(first.id);
  }, 20_000);
});

describe('reading what the login prints', () => {
  test('terminal dressing is stripped and the account url is picked out of the noise', () => {
    expect(plainText(`${ESC}[1mBold${ESC}[0m plain`)).toBe('Bold plain');
    expect(plainText('nothing to strip')).toBe('nothing to strip');
    expect(loginUrlIn('go to https://claude.ai/oauth/authorize?x=1 now')).toBe('https://claude.ai/oauth/authorize?x=1');
    expect(loginUrlIn('see https://example.com/docs and https://console.anthropic.com/x')).toBe('https://console.anthropic.com/x');
    expect(loginUrlIn('visit https://example.com/only.')).toBe('https://example.com/only');
    expect(loginUrlIn('no link here')).toBeNull();
  });
});
