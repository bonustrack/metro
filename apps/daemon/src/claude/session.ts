import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { errMsg, log } from '@metro-labs/core/log';
import { isRecord } from '@metro-labs/core/is-record';
import { readJson, writeJson } from '@metro-labs/core/secure-fs';
import { METRO_VERSION } from '@metro-labs/core/version';
import { agentsDir, listAgentFiles } from '../agents/files.js';
import { notReady, readModelConfig } from '../gateway/model-config.js';
import { claudeDir, listClaudeProjects } from './files.js';
import { claudeAccount, claudeInstalled } from './login.js';
import { trustFolder } from './onboarding.js';

export const SESSION_NAME = 'metro';
const STATE_FILE = 'claude-session.json';
const WARNING = 'WARNING: Loading development channels';
const CONFIRM_POLL_MS = 500;
const CONFIRM_WAIT_MS = 60_000;
const WATCH_MS = 15_000;
const STRIKE_WINDOW_MS = 60_000;
const MAX_STRIKES = 5;
const PAUSE_MS = 30 * 60_000;

export interface SessionDeps {
  tmux?: string;
  metro?: string[];
  home?: string;
  agents?: string;
  signedIn?: () => boolean;
  now?: () => number;
  version?: string;
  continues?: (home: string) => boolean;
}

export interface SessionStatus {
  name: string;
  running: boolean;
  autostart: boolean;
  blocked: string | null;
  lastStartedAt: string | null;
  lastError: string | null;
}

interface Memory {
  lastStartedAt: number | null;
  lastError: string | null;
  strikes: number;
  pausedUntil: number;
}

const memory: Memory = { lastStartedAt: null, lastError: null, strikes: 0, pausedUntil: 0 };

const statePath = (agents: string): string => join(agents, STATE_FILE);

function readState(agents: string): Record<string, unknown> {
  const raw = readJson<unknown>(statePath(agents), null);
  return isRecord(raw) ? raw : {};
}

const writeState = (agents: string, patch: Record<string, unknown>): void => {
  writeJson(statePath(agents), { ...readState(agents), ...patch });
};

export const autostartEnabled = (agents = agentsDir()): boolean => readState(agents).autostart !== false;

export function setAutostart(enabled: boolean, agents = agentsDir()): void {
  writeState(agents, { autostart: enabled });
}

export function startedVersion(agents = agentsDir()): string | null {
  const version = readState(agents).version;
  return typeof version === 'string' ? version : null;
}

function tmuxOk(tmux: string, args: string[]): boolean {
  const run = spawnSync(tmux, args, { stdio: 'ignore' });
  return run.error === undefined && run.status === 0;
}

export const sessionRunning = (tmux = 'tmux'): boolean => tmuxOk(tmux, ['has-session', '-t', SESSION_NAME]);

function realDir(dir: string): string {
  try {
    return realpathSync(dir);
  } catch {
    return dir;
  }
}

export function hasConversation(home: string, dir = claudeDir()): boolean {
  const cwd = realDir(home);
  return listClaudeProjects(dir).some((project) => project.sessions > 0 && project.cwd !== null && realDir(project.cwd) === cwd);
}

function metroCommand(deps: SessionDeps, home: string): string[] {
  const bin = process.env.METRO_CLI_BIN?.trim() ?? '';
  const base = deps.metro ?? (bin === '' ? ['metro', 'claude'] : [process.execPath, bin, 'claude']);
  const continues = (deps.continues ?? hasConversation)(home);
  return continues ? [...base, '-c'] : base;
}

function credentialReady(deps: SessionDeps): string | null {
  const signedIn = deps.signedIn ?? (() => claudeAccount().signedIn);
  if (signedIn()) return null;
  try {
    const cfg = readModelConfig(deps.agents ?? agentsDir());
    if (cfg.provider !== 'anthropic' && notReady(cfg) === null) return null;
  } catch (err) {
    return `the Model page is not readable (${errMsg(err)})`;
  }
  return 'Claude Code is not signed in and the Model page routes nowhere yet';
}

export function sessionBlocked(deps: SessionDeps = {}): string | null {
  const agents = deps.agents ?? agentsDir();
  if (listAgentFiles(agents).length === 0) return 'no agent on this machine yet';
  if (deps.metro === undefined && !claudeInstalled()) return 'Claude Code is not installed on this machine';
  if (!tmuxOk(deps.tmux ?? 'tmux', ['-V'])) return 'tmux is not installed on this machine';
  return credentialReady(deps);
}

function capturePane(tmux: string): string {
  const run = spawnSync(tmux, ['capture-pane', '-p', '-t', SESSION_NAME], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  return run.error === undefined && run.status === 0 ? run.stdout : '';
}

function confirmChannels(tmux: string, until: number): void {
  const tick = (): void => {
    const pane = capturePane(tmux);
    if (pane.includes(WARNING) && pane.includes('server:metro')) {
      spawnSync(tmux, ['send-keys', '-t', SESSION_NAME, 'Enter'], { stdio: 'ignore' });
      log.info('claude-session: confirmed the development channels dialog for server:metro');
      return;
    }
    if (Date.now() < until && sessionRunning(tmux)) setTimeout(tick, CONFIRM_POLL_MS).unref();
  };
  setTimeout(tick, CONFIRM_POLL_MS).unref();
}

function recordStart(deps: SessionDeps, tmux: string, now: number, run: { error?: Error; status: number | null; stderr: string }): void {
  memory.lastStartedAt = now;
  if (run.error !== undefined || run.status !== 0) {
    memory.lastError = run.error === undefined ? `tmux new-session exited ${String(run.status)}: ${run.stderr.trim()}` : errMsg(run.error);
    log.warn({ err: memory.lastError }, 'claude-session: tmux could not start');
    return;
  }
  memory.lastError = null;
  writeState(deps.agents ?? agentsDir(), { version: deps.version ?? METRO_VERSION });
  confirmChannels(tmux, now + CONFIRM_WAIT_MS);
}

export function startSession(deps: SessionDeps = {}): SessionStatus {
  const tmux = deps.tmux ?? 'tmux';
  const home = deps.home ?? homedir();
  const now = (deps.now ?? Date.now)();
  const trusted = trustFolder(home);
  const [command = 'metro', ...args] = metroCommand(deps, home);
  const run = spawnSync(tmux, ['new-session', '-d', '-s', SESSION_NAME, '-c', home, '-x', '200', '-y', '50', command, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], cwd: home });
  recordStart(deps, tmux, now, run);
  if (memory.lastError === null) log.info({ home, trusted, command: [command, ...args].join(' ') }, 'claude-session: started Claude Code in tmux');
  return sessionStatus(deps);
}

export function stopSession(deps: SessionDeps = {}): SessionStatus {
  spawnSync(deps.tmux ?? 'tmux', ['kill-session', '-t', SESSION_NAME], { stdio: 'ignore' });
  return sessionStatus(deps);
}

export function sessionStatus(deps: SessionDeps = {}): SessionStatus {
  return {
    name: SESSION_NAME,
    running: sessionRunning(deps.tmux ?? 'tmux'),
    autostart: autostartEnabled(deps.agents ?? agentsDir()),
    blocked: sessionBlocked(deps),
    lastStartedAt: memory.lastStartedAt === null ? null : new Date(memory.lastStartedAt).toISOString(),
    lastError: memory.lastError,
  };
}

function strike(now: number): boolean {
  if (memory.lastStartedAt !== null && now - memory.lastStartedAt < STRIKE_WINDOW_MS) memory.strikes += 1;
  else memory.strikes = 1;
  if (memory.strikes < MAX_STRIKES) return false;
  memory.pausedUntil = now + PAUSE_MS;
  memory.strikes = 0;
  log.warn({ pauseMinutes: PAUSE_MS / 60_000 }, 'claude-session: Claude Code keeps exiting right after starting; not restarting it for a while');
  return true;
}

export type Ensured = 'started' | 'restarted' | 'running' | 'blocked' | 'off' | 'paused';

function holdsBack(deps: SessionDeps, now: number): Ensured | null {
  if (now < memory.pausedUntil) return 'paused';
  if (sessionBlocked(deps) !== null) return 'blocked';
  return strike(now) ? 'paused' : null;
}

interface Resolved {
  now: number;
  agents: string;
  version: string;
  tmux: string;
}

const resolved = (deps: SessionDeps): Resolved => ({
  now: (deps.now ?? Date.now)(),
  agents: deps.agents ?? agentsDir(),
  version: deps.version ?? METRO_VERSION,
  tmux: deps.tmux ?? 'tmux',
});

function situation(r: Resolved): 'running' | 'stale' | 'absent' {
  if (!sessionRunning(r.tmux)) return 'absent';
  return startedVersion(r.agents) === r.version ? 'running' : 'stale';
}

export function ensureSession(deps: SessionDeps = {}): Ensured {
  const r = resolved(deps);
  if (!autostartEnabled(r.agents)) return 'off';
  const found = situation(r);
  if (found === 'running') return 'running';
  const held = holdsBack(deps, r.now);
  if (held !== null) return held;
  if (found === 'stale') {
    log.info({ was: startedVersion(r.agents), now: r.version }, 'claude-session: restarting the session an older metro started, so the new plugin and flags load');
    stopSession(deps);
  }
  startSession(deps);
  return found === 'stale' ? 'restarted' : 'started';
}

let watcher: ReturnType<typeof setInterval> | null = null;

export function watchSession(deps: SessionDeps = {}, everyMs = WATCH_MS): void {
  if (watcher !== null) return;
  const tick = (): void => {
    try {
      const outcome = ensureSession(deps);
      if (outcome === 'started' || outcome === 'restarted') log.info({ outcome }, 'claude-session: Claude Code is up');
    } catch (err) {
      log.warn({ err: errMsg(err) }, 'claude-session: check failed');
    }
  };
  watcher = setInterval(tick, everyMs);
  watcher.unref();
  setTimeout(tick, 1_000).unref();
}

export function unwatchSession(): void {
  if (watcher !== null) clearInterval(watcher);
  watcher = null;
}
