import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { ApiError } from '@metro-labs/http/api-error';
import { claudeTokenIn, withoutClaudeTokens } from '@metro-labs/core/claude-token';
import { errMsg, log } from '@metro-labs/core/log';
import { agentCommand, asAgent, CLAUDE_ENV, claudeBin } from '../agent-user/user.js';

const TOKEN_ARGS = ['setup-token'];
const TTL_MS = 10 * 60_000;
const TOKEN_TTL_MS = 2 * 60_000;
const OUTPUT_MAX = 8_000;
const RAW_MAX = 256_000;
const COLS = 500;
const ROWS = 40;
const DRAIN_MS = 250;
const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const CSI = /^\[[0-?]*[ -/]*[@-~]/;
const SHORT_ESCAPE = /^[()#%].|^./s;
const URL_RE = /https:\/\/[^\s"'`]+/g;
const TOKEN_HEAD_RE = /^[A-Za-z0-9_-]+/;
const FINISHED_TOKEN_RE = /sk-ant-oat01-[A-Za-z0-9_-]+[\r\n]/;

type LoginState = 'pending' | 'done' | 'failed';

export interface LoginView {
  id: string;
  state: LoginState;
  url: string | null;
  output: string;
  error: string | null;
  token?: string;
}

interface Live {
  id: string;
  startedAt: number;
  state: LoginState;
  raw: string;
  error: string | null;
  token: string | null;
  write: (text: string) => void;
  kill: () => void;
}

export interface LoginDeps {
  command?: string[];
}

let live: Live | null = null;

function plainPart(part: string): string {
  if (part.startsWith('[')) return part.replace(CSI, '');
  if (part.startsWith(']')) return part.includes(BEL) ? part.slice(part.indexOf(BEL) + 1) : '';
  return part.replace(SHORT_ESCAPE, '');
}

export function plainText(raw: string): string {
  return raw
    .split(ESC)
    .map((part, index) => (index === 0 ? part : plainPart(part)))
    .join('');
}

export function loginUrlIn(output: string): string | null {
  const found = output.match(URL_RE) ?? [];
  const trimmed = found.map((url) => url.replace(/[.,)]+$/, ''));
  return trimmed.find((url) => url.includes('claude.ai') || url.includes('anthropic.com')) ?? trimmed[0] ?? null;
}

function view(session: Live): LoginView {
  const shown = withoutClaudeTokens(plainText(session.raw));
  const base = { id: session.id, state: session.state, url: loginUrlIn(shown), output: shown.slice(-OUTPUT_MAX), error: session.error };
  const token = session.token;
  if (session.state !== 'done' || token === null) return base;
  session.token = null;
  log.info('claude-login: the long-lived Claude token was handed to the page once, and the box keeps no copy');
  return { ...base, token };
}

function sweep(now: number): void {
  if (live?.state === 'pending' && now - live.startedAt > TTL_MS) {
    live.kill();
    live = null;
  }
}

const CHECK_MS = 30_000;

let installed: { at: number; value: boolean } | null = null;

export function forgetClaudeChecks(): void {
  installed = null;
}

export function claudeInstalled(): boolean {
  const now = Date.now();
  if (installed !== null && now - installed.at < CHECK_MS) return installed.value;
  const run = spawnSync(...asAgent(claudeBin(), ['--version'], CLAUDE_ENV), { stdio: 'ignore', env: { ...process.env, ...CLAUDE_ENV } });
  installed = { at: now, value: run.error === undefined && run.status === 0 };
  return installed.value;
}

function note(session: Live, chunk: string): void {
  if (session.state !== 'pending') return;
  const next = session.raw + chunk;
  session.raw = next.length > RAW_MAX ? next.slice(next.length - RAW_MAX).replace(TOKEN_HEAD_RE, '') : next;
  if (session.token !== null) return;
  const text = plainText(session.raw);
  if (FINISHED_TOKEN_RE.test(text)) session.token = claudeTokenIn(text);
}

function dropTokenLater(session: Live): void {
  setTimeout(() => {
    if (session.token === null) return;
    session.token = null;
    session.state = 'failed';
    session.error = 'the token was not collected in time; start again';
    log.info('claude-login: the long-lived Claude token was not collected in time, so it was dropped');
  }, TOKEN_TTL_MS).unref();
}

function settle(session: Live, code: number): void {
  const text = plainText(session.raw);
  const token = session.token ?? claudeTokenIn(text);
  session.raw = withoutClaudeTokens(text);
  session.token = token;
  if (token === null) session.error = code === 0 ? 'Claude Code finished without printing a token; try again' : `the sign-in ended with status ${String(code)}`;
  session.state = token === null ? 'failed' : 'done';
  if (token !== null) dropTokenLater(session);
  log.info({ state: session.state }, 'claude-login: claude setup-token finished');
}

export function startClaudeLogin(deps: LoginDeps = {}, now = Date.now()): LoginView {
  sweep(now);
  if (live?.state === 'pending') return view(live);
  if (live !== null) live.token = null;
  const env = { TERM: 'xterm-256color', ...CLAUDE_ENV };
  const command = deps.command ?? agentCommand([claudeBin(), ...TOKEN_ARGS], env);
  const session: Live = { id: randomBytes(9).toString('base64url'), startedAt: now, state: 'pending', raw: '', error: null, token: null, write: () => undefined, kill: () => undefined };
  const decoder = new TextDecoder();
  const terminal = new Bun.Terminal({
    cols: COLS,
    rows: ROWS,
    data: (_term, chunk: Uint8Array) => {
      note(session, decoder.decode(chunk, { stream: true }));
    },
  });
  const proc = Bun.spawn(command, { terminal, env: { ...process.env, ...env } });
  session.write = (text: string) => {
    terminal.write(Buffer.from(`${text}\r`, 'utf8'));
  };
  session.kill = () => {
    proc.kill();
    terminal.close();
  };
  proc.exited
    .then((code) => {
      session.write = () => undefined;
      setTimeout(() => {
        terminal.close();
        settle(session, code);
      }, DRAIN_MS).unref();
    })
    .catch((err: unknown) => {
      session.state = 'failed';
      session.error = errMsg(err);
    });
  live = session;
  log.info({ command: command[0] }, 'claude-login: started claude setup-token');
  return view(session);
}

function current(id: string): Live {
  const session = live;
  if (session?.id !== id) throw new ApiError('that sign-in is over; start another one', 404);
  return session;
}

export function claudeLoginView(id: string, now = Date.now()): LoginView {
  sweep(now);
  return view(current(id));
}

export function answerClaudeLogin(id: string, text: string): LoginView {
  const session = current(id);
  if (session.state !== 'pending') throw new ApiError('that sign-in has already finished', 409);
  session.write(text);
  return view(session);
}

export function endClaudeLogin(id: string): { ended: true } {
  const session = current(id);
  session.kill();
  session.token = null;
  live = null;
  return { ended: true };
}

export const forgetClaudeLogin = (): void => {
  live?.kill();
  if (live !== null) live.token = null;
  live = null;
};
