import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { markOnboardingDone } from './onboarding.js';
import { ApiError } from '@metro-labs/http/api-error';
import { isRecord } from '@metro-labs/core/is-record';
import { errMsg, log } from '@metro-labs/core/log';
import { agentCommand, asAgent, claudeBin } from '../agent-user/user.js';

const LOGIN_ARGS = ['auth', 'login', '--claudeai'];
const STATUS_COMMAND = ['auth', 'status', '--json'];
const TTL_MS = 10 * 60_000;
const OUTPUT_MAX = 8_000;
const COLS = 100;
const ROWS = 40;
const ESC = String.fromCharCode(27);
const CSI = /^\[[0-9;?]*[a-zA-Z]/;
const URL_RE = /https:\/\/[^\s"'`]+/g;

type LoginState = 'pending' | 'done' | 'failed';

export interface LoginView {
  id: string;
  state: LoginState;
  url: string | null;
  output: string;
  error: string | null;
}

export interface LoginTarget {
  key: string;
  env: Record<string, string>;
  settle: (ok: boolean) => Promise<string | null>;
}

interface Live {
  id: string;
  startedAt: number;
  state: LoginState;
  output: string;
  error: string | null;
  target: LoginTarget | null;
  write: (text: string) => void;
  kill: () => void;
}

export interface LoginDeps {
  command?: string[];
}

let live: Live | null = null;

export function plainText(raw: string): string {
  return raw
    .split(ESC)
    .map((part, index) => (index === 0 ? part : part.replace(CSI, '')))
    .join('');
}

export function loginUrlIn(output: string): string | null {
  const found = output.match(URL_RE) ?? [];
  const trimmed = found.map((url) => url.replace(/[.,)]+$/, ''));
  return trimmed.find((url) => url.includes('claude.ai') || url.includes('anthropic.com')) ?? trimmed[0] ?? null;
}

const view = (session: Live): LoginView => ({
  id: session.id,
  state: session.state,
  url: loginUrlIn(session.output),
  output: session.output,
  error: session.error,
});

function sweep(now: number): void {
  if (live !== null && live.state !== 'pending') return;
  if (live !== null && now - live.startedAt > TTL_MS) {
    live.kill();
    live = null;
  }
}

const CHECK_MS = 30_000;

interface Checked<T> {
  at: number;
  value: T;
}

const checks: { installed?: Checked<boolean>; account?: Checked<ClaudeAccount> } = {};

function remembered<T>(slot: Checked<T> | undefined, read: () => T, keep: (c: Checked<T>) => void): T {
  const now = Date.now();
  if (slot !== undefined && now - slot.at < CHECK_MS) return slot.value;
  const value = read();
  keep({ at: now, value });
  return value;
}

function forgetClaudeChecks(): void {
  delete checks.installed;
  delete checks.account;
}

export function claudeInstalled(): boolean {
  return remembered(checks.installed, () => {
    const run = spawnSync(...asAgent(claudeBin(), ['--version']), { stdio: 'ignore' });
    return run.error === undefined && run.status === 0;
  }, (c) => {
    checks.installed = c;
  });
}

export interface ClaudeAccount {
  signedIn: boolean;
  account: string | null;
  plan: string | null;
}

const SIGNED_OUT: ClaudeAccount = { signedIn: false, account: null, plan: null };

export function claudeAccount(): ClaudeAccount {
  return remembered(checks.account, () => claudeAccountIn({}), (c) => {
    checks.account = c;
  });
}

const textOf = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

export function claudeAccountIn(env: Record<string, string>): ClaudeAccount {
  const run = spawnSync(...asAgent(claudeBin(), STATUS_COMMAND, env), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, ...env } });
  if (run.error !== undefined || typeof run.stdout !== 'string') return SIGNED_OUT;
  try {
    const parsed: unknown = JSON.parse(run.stdout);
    if (!isRecord(parsed)) return SIGNED_OUT;
    const account = textOf(parsed.email) ?? textOf(parsed.organization) ?? textOf(parsed.orgName);
    return { signedIn: parsed.authenticated === true || parsed.loggedIn === true || account !== null, account, plan: textOf(parsed.subscriptionType) };
  } catch {
    return SIGNED_OUT;
  }
}

function note(session: Live, chunk: string): void {
  const next = session.output + plainText(chunk);
  session.output = next.length > OUTPUT_MAX ? next.slice(next.length - OUTPUT_MAX) : next;
}

async function verdict(session: Live, code: number): Promise<string | null> {
  const problem = code === 0 ? null : `the login ended with status ${String(code)}`;
  if (session.target === null) return problem;
  try {
    return (await session.target.settle(problem === null)) ?? problem;
  } catch (err) {
    return errMsg(err);
  }
}

function runningFor(target: LoginTarget | null): Live | null {
  if (live === null || live.state !== 'pending') return null;
  if (live.target?.key === target?.key) return live;
  live.kill();
  live = null;
  return null;
}

export function startClaudeLogin(deps: LoginDeps = {}, now = Date.now(), target: LoginTarget | null = null): LoginView {
  sweep(now);
  const running = runningFor(target);
  if (running !== null) return view(running);
  const env = { TERM: 'xterm-256color', ...target?.env };
  const command = deps.command ?? agentCommand([claudeBin(), ...LOGIN_ARGS], env);
  const session: Live = {
    id: randomBytes(9).toString('base64url'),
    startedAt: now,
    state: 'pending',
    output: '',
    error: null,
    target,
    write: () => undefined,
    kill: () => undefined,
  };
  const terminal = new Bun.Terminal({
    cols: COLS,
    rows: ROWS,
    data: (_term, chunk: Uint8Array) => {
      note(session, Buffer.from(chunk).toString('utf8'));
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
    .then(async (code) => {
      session.write = () => undefined;
      terminal.close();
      forgetClaudeChecks();
      session.error = await verdict(session, code);
      session.state = session.error === null ? 'done' : 'failed';
      const onboarding = session.error === null ? markOnboardingDone() : 'skipped';
      log.info({ state: session.state, onboarding, own: session.target !== null }, 'claude-login: the official login finished');
    })
    .catch((err: unknown) => {
      session.state = 'failed';
      session.error = errMsg(err);
    });
  live = session;
  log.info({ command: command[0] }, 'claude-login: started');
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
  live = null;
  return { ended: true };
}

export const forgetClaudeLogin = (): void => {
  live?.kill();
  live = null;
};
