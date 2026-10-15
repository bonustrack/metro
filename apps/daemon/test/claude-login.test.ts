import { afterEach, describe, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { handleClaudeRequest } from '../src/claude/api.js';
import { forgetClaudeLogin, loginUrlIn, plainText } from '../src/claude/login.js';
import { auth } from './identity-helper.ts';

const OWNER = '0xef8305e140ac520225daf050e2f71d5fbcc543e7';
const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const TOKEN = `sk-ant-oat01-${'Qw3_rT-y'.repeat(12)}AA`;
const URL = 'https://claude.ai/oauth/authorize?code=true&client_id=abc&state=xyz';

const SETUP_TOKEN = [
  `printf '\\033[2mBrowser didn'"'"'t open? Use the url below to sign in \\033[22m\\n\\033]8;;${URL}\\007${URL}\\033]8;;\\007\\n'`,
  `printf 'Paste code here if prompted > '`,
  'read code',
  'test "$code" = "the-code" || exit 3',
  `printf '\\033[2K\\033[1A\\033[32m✓ Long-lived authentication token created successfully!\\033[39m\\n\\nYour OAuth token (valid for 1 year):\\n\\n\\033[33m${TOKEN.slice(0, 40)}'`,
  'sleep 0.2',
  `printf '${TOKEN.slice(40)}\\033[39m\\n\\n\\033[2mStore this token securely. You won'"'"'t be able to see it again.\\033[22m\\n\\033[2mUse this token by setting: export CLAUDE_CODE_OAUTH_TOKEN=<token>\\033[22m\\n'`,
].join('; ');

interface View {
  id: string;
  state: string;
  url: string | null;
  output: string;
  error: string | null;
  token?: string;
}

let server: Server;
let base = '';

async function start(command: string[]): Promise<string> {
  server = createServer((req, res) => {
    if (handleClaudeRequest(req, res, { login: { command } })) return;
    res.writeHead(404).end();
  });
  await new Promise<void>((done) => {
    server.listen(0, '127.0.0.1', done);
  });
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  return base;
}

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

afterEach(() => {
  forgetClaudeLogin();
  server.close();
});

describe('getting a long-lived Claude token from claude setup-token on the box', () => {
  test('the url is surfaced, the code goes back in, and the printed token is handed out once and never shown in the output', async () => {
    await start(['sh', '-c', SETUP_TOKEN]);
    const started = (await (await call('POST', '/api/claude/login')).json()) as View;
    expect(started.state).toBe('pending');
    const path = `/api/claude/login/${started.id}`;
    await until(async () => (await viewOf(path)).url !== null);
    const waiting = await viewOf(path);
    expect(waiting.url).toBe(URL);
    expect(waiting.output).not.toContain(ESC);
    expect(waiting.output).not.toContain(BEL);
    expect((await call('POST', path, { text: 'the-code' })).status).toBe(200);
    let done: View | null = null;
    await until(async () => {
      const seen = await viewOf(path);
      if (seen.state === 'pending') return false;
      done = seen;
      return true;
    });
    expect(done).toMatchObject({ state: 'done', error: null, token: TOKEN });
    const output = (done as View | null)?.output ?? '';
    expect(output).toContain('Your OAuth token (valid for 1 year):');
    expect(output).toContain('[token]');
    expect(output).not.toContain('sk-ant-oat01-');
    const again = await viewOf(path);
    expect(again.state).toBe('done');
    expect(again).not.toHaveProperty('token');
    expect(JSON.stringify(again)).not.toContain(TOKEN.slice(13, 40));
  }, 20_000);

  test('only an admin may read a sign-in, since its answer carries the token', async () => {
    await start(['sh', '-c', SETUP_TOKEN]);
    const started = (await (await call('POST', '/api/claude/login')).json()) as View;
    expect((await call('GET', `/api/claude/login/${started.id}`, undefined, 'member')).status).toBe(403);
    expect((await call('POST', '/api/claude/login', undefined, 'member')).status).toBe(403);
    expect((await call('GET', '/api/claude/login', undefined, 'member')).status).toBe(200);
  }, 20_000);

  test('a wrong code fails with no token, and an exit with no token printed is a failure too', async () => {
    await start(['sh', '-c', SETUP_TOKEN]);
    const started = (await (await call('POST', '/api/claude/login')).json()) as View;
    const path = `/api/claude/login/${started.id}`;
    await until(async () => (await viewOf(path)).url !== null);
    await call('POST', path, { text: 'wrong' });
    await until(async () => (await viewOf(path)).state !== 'pending');
    const ended = await viewOf(path);
    expect(ended).toMatchObject({ state: 'failed', error: 'the sign-in ended with status 3' });
    expect(ended).not.toHaveProperty('token');
    expect((await call('POST', path, { text: 'again' })).status).toBe(409);
    forgetClaudeLogin();
    await start(['sh', '-c', 'printf "all done\\n"']);
    const quiet = (await (await call('POST', '/api/claude/login')).json()) as View;
    await until(async () => (await viewOf(`/api/claude/login/${quiet.id}`)).state !== 'pending');
    expect(await viewOf(`/api/claude/login/${quiet.id}`)).toMatchObject({ state: 'failed', error: 'Claude Code finished without printing a token; try again' });
  }, 20_000);

  test('a stale id is a 404, the body must carry text, and a second start hands back the running sign-in', async () => {
    await start(['sh', '-c', SETUP_TOKEN]);
    const started = (await (await call('POST', '/api/claude/login')).json()) as View;
    const path = `/api/claude/login/${started.id}`;
    expect(((await (await call('POST', '/api/claude/login')).json()) as View).id).toBe(started.id);
    expect((await call('POST', path, { nope: 1 })).status).toBe(400);
    expect((await call('GET', '/api/claude/login/made-up')).status).toBe(404);
    expect((await call('PUT', path, { text: 'x' })).status).toBe(405);
    expect((await call('DELETE', path)).status).toBe(200);
    expect((await call('GET', path)).status).toBe(404);
  }, 20_000);
});

describe('reading what the terminal prints', () => {
  test('colours, cursor moves, hyperlinks and short escapes are stripped, and the account url is picked out', () => {
    expect(plainText(`${ESC}[1mBold${ESC}[0m plain`)).toBe('Bold plain');
    expect(plainText(`${ESC}]8;;https://claude.ai/x${BEL}https://claude.ai/x${ESC}]8;;${BEL} done`)).toBe('https://claude.ai/x done');
    expect(plainText(`${ESC}]8;;https://claude.ai/y${ESC}\\link${ESC}]8;;${ESC}\\`)).toBe('link');
    expect(plainText(`${ESC}[?2004h${ESC}[>4;2mtext${ESC}7${ESC}8${ESC}(Bend`)).toBe('textend');
    expect(plainText('nothing to strip')).toBe('nothing to strip');
    expect(loginUrlIn('go to https://claude.ai/oauth/authorize?x=1 now')).toBe('https://claude.ai/oauth/authorize?x=1');
    expect(loginUrlIn('see https://example.com/docs and https://console.anthropic.com/x')).toBe('https://console.anthropic.com/x');
    expect(loginUrlIn('visit https://example.com/only.')).toBe('https://example.com/only');
    expect(loginUrlIn('no link here')).toBeNull();
  });
});
