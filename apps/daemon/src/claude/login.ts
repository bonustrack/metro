import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { markOnboardingDone } from './onboarding.js';
import { ApiError } from '@metro-labs/http/api-error';
import { isRecord } from '@metro-labs/core/is-record';
import { errMsg, log } from '@metro-labs/core/log';

const LOGIN_COMMAND = ['claude', 'auth', 'login', '--claudeai'];
const STATUS_COMMAND = ['auth', 'status', '--json'];
const TTL_MS = 10 * 60_000;
const OUTPUT_MAX = 8_000;
const COLS = 100;
const ROWS = 40;
const ESC = String.fromCharCode(27);
const CSI = /^\[[0-9;?]*[a-zA-Z]/;
const URL_RE = /https:\/\/[^\s"'`]+/g;

export type LoginState = 'pending' | 'done' | 'failed';

export interface LoginView {
  id: string;
  state: LoginState;
  url: string | null;
  output: string;
  error: string | null;
}

interface Live {
  id: string;
  startedAt: number;
  state: LoginState;
  output: string;
  error: string | null;
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

export function claudeInstalled(): boolean {
  const run = spawnSync('claude', ['--version'], { stdio: 'ignore' });
  return run.error === undefined && run.status === 0;
}

export function claudeAccount(): { signedIn: boolean; account: string | null } {
  const run = spawnSync('claude', STATUS_COMMAND, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  if (run.error !== undefined || typeof run.stdout !== 'string') return { signedIn: false, account: null };
  try {
    const parsed: unknown = JSON.parse(run.stdout);
    if (!isRecord(parsed)) return { signedIn: false, account: null };
    const account = typeof parsed.email === 'string' ? parsed.email : typeof parsed.organization === 'string' ? parsed.organization : null;
    return { signedIn: parsed.authenticated === true || parsed.loggedIn === true || account !== null, account };
  } catch {
    return { signedIn: false, account: null };
  }
}

function note(session: Live, chunk: string): void {
  const next = session.output + plainText(chunk);
  session.output = next.length > OUTPUT_MAX ? next.slice(next.length - OUTPUT_MAX) : next;
}

export function startClaudeLogin(deps: LoginDeps = {}, now = Date.now()): LoginView {
  sweep(now);
  if (live !== null && live.state === 'pending') return view(live);
  const command = deps.command ?? LOGIN_COMMAND;
  const session: Live = {
    id: randomBytes(9).toString('base64url'),
    startedAt: now,
    state: 'pending',
    output: '',
    error: null,
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
  const proc = Bun.spawn(command, { terminal, env: { ...process.env, TERM: 'xterm-256color' } });
  session.write = (text: string) => {
    terminal.write(Buffer.from(`${text}\r`, 'utf8'));
  };
  session.kill = () => {
    proc.kill();
    terminal.close();
  };
  proc.exited
    .then((code) => {
      session.state = code === 0 ? 'done' : 'failed';
      if (code !== 0) session.error = `the login ended with status ${String(code)}`;
      terminal.close();
      const onboarding = code === 0 ? markOnboardingDone() : 'skipped';
      log.info({ state: session.state, onboarding }, 'claude-login: the official login finished');
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
