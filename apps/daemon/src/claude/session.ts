import { spawn, spawnSync } from 'node:child_process';
import { ApiError } from '@metro-labs/http/api-error';
import type { RunnerActivity } from '@metro-labs/core/runner-activity';
import { readAgentActivity } from './runner-activity.js';
import { sdkAlive, stopSdkRunner } from './runner-process.js';
import { syncAgentView } from '../agent-user/view.js';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { errMsg, log } from '@metro-labs/core/log';
import { isRecord } from '@metro-labs/core/is-record';
import { readJson, writeJson } from '@metro-labs/core/secure-fs';
import { METRO_VERSION } from '@metro-labs/core/version';
import { agentsDir, listAgentFiles } from '../agents/files.js';
import { primaryRoute, setupNotReady, type ModelSetup } from '@metro-labs/inference/model-config';
import { effectiveSetup } from '../gateway/effective.js';
import { inSessionScope } from './memory.js';
import { runningAsRoot } from '../metro-user/privilege.js';
import { agentUser, agentUserExpected, agentViewDir, asAgent, claudeHome } from '../agent-user/user.js';

function sessionEnv(): Record<string, string> {
  const user = agentUser();
  if (user === null) return {};
  const port = process.env.METRO_WEBHOOK_PORT?.trim() ?? '';
  return { METRO_AGENTS_DIR: agentViewDir(user), ...(port === '' ? {} : { METRO_WEBHOOK_PORT: port }) };
}

const SESSION_NAME = 'metro';
const STATE_FILE = 'claude-session.json';
const WATCH_MS = 15_000;
const STRIKE_WINDOW_MS = 60_000;
const MAX_STRIKES = 5;
const PAUSE_MS = 30 * 60_000;
const PREPARE_MS = 16 * 60_000;

export interface SessionDeps {
  tmux?: string;
  metro?: string[];
  home?: string;
  agents?: string;
  model?: () => ModelSetup;
  now?: () => number;
  version?: string;
}

export interface SessionStatus {
  name: string;
  running: boolean;
  activity?: RunnerActivity | null;
  autostart: boolean;
  blocked: string | null;
  lastStartedAt: string | null;
  lastError: string | null;
}

export interface SessionSnapshot {
  running: boolean;
  activity: RunnerActivity | null;
  lastStartedAt: string | null;
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

function startedVersion(agents = agentsDir()): string | null {
  const version = readState(agents).version;
  return typeof version === 'string' ? version : null;
}

function tmuxOk(tmux: string, args: string[]): boolean {
  const run = spawnSync(...asAgent(tmux, args), { stdio: 'ignore' });
  return run.error === undefined && run.status === 0;
}

export const sessionRunning = (tmux = 'tmux'): boolean => tmuxOk(tmux, ['has-session', '-t', SESSION_NAME]);

export const tmuxServerUp = (tmux = 'tmux'): boolean => tmuxOk(tmux, ['list-sessions']);

export function metroCli(args: string[], fixed?: string[]): string[] {
  const bin = process.env.METRO_CLI_BIN?.trim() ?? '';
  const runtime = agentUser() === null ? process.execPath : 'node';
  const base = fixed ?? (bin === '' ? ['metro', ...args] : [runtime, bin, ...args]);
  const env = Object.entries(sessionEnv()).map(([k, v]) => `${k}=${v}`);
  return env.length === 0 || fixed !== undefined ? base : ['env', ...env, ...base];
}

const sessionHome = (deps: SessionDeps): string => deps.home ?? claudeHome() ?? homedir();

export function assertSessionStopped(deps: SessionDeps = {}): void {
  if (sessionLive(deps)) throw new ApiError('The session is running. Let it finish its work, stop it, then change its permissions or prompt and start it again.', 409);
}

export function prepareRunnerStore(): Promise<void> {
  const [bin = 'metro', ...args] = metroCli(['agent', '--prepare']);
  return new Promise<void>((resolve, reject) => {
    const child = spawn(...asAgent(bin, args), { stdio: ['ignore', 'ignore', 'pipe'], cwd: '/', timeout: PREPARE_MS });
    let said = '';
    child.stderr.on('data', (chunk: Buffer) => {
      said = (said + chunk.toString('utf8')).slice(-2000);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`metro agent --prepare failed: ${said.trim() || `exit ${String(code)}`}`));
    });
  });
}

const NO_MODEL = "the organization routes this agent to no model yet: choose one on the organization's Gateway page";

function credentialReady(deps: SessionDeps): string | null {
  try {
    const primary = primaryRoute((deps.model ?? (() => effectiveSetup()))());
    return primary === null ? NO_MODEL : setupNotReady(primary);
  } catch (err) {
    return `the model setup is not readable (${errMsg(err)})`;
  }
}

const agentUserMissing = (deps: SessionDeps): boolean =>
  deps.metro === undefined && agentUserExpected() && agentUser() === null;

const ROOT_REFUSED = 'Metro runs as root; reinstall it as the metro user';

export function sessionBlocked(deps: SessionDeps = {}): string | null {
  if (runningAsRoot()) return ROOT_REFUSED;
  if (listAgentFiles(deps.agents ?? agentsDir()).length === 0) return 'no agent on this machine yet';
  return launchBlocked(deps);
}

function launchBlocked(deps: SessionDeps): string | null {
  if (agentUserMissing(deps))
    return 'Claude Code runs as the user agent here, and that user is not ready yet; see the log';
  if (!tmuxOk(deps.tmux ?? 'tmux', ['-V'])) return 'tmux is not installed on this machine';
  return credentialReady(deps);
}

function recordStart(deps: SessionDeps, now: number, run: { error?: Error; status: number | null; stderr: string }): void {
  memory.lastStartedAt = now;
  if (run.error !== undefined || run.status !== 0) {
    memory.lastError = run.error === undefined ? `tmux new-session exited ${String(run.status)}: ${run.stderr.trim()}` : errMsg(run.error);
    log.warn({ err: memory.lastError }, 'claude-session: tmux could not start');
    return;
  }
  memory.lastError = null;
  writeState(deps.agents ?? agentsDir(), { version: deps.version ?? METRO_VERSION });
}

function tmuxLaunch(deps: SessionDeps, tmux: string, args: string[]): [string, string[]] {
  const launch = asAgent(tmux, args);
  return deps.tmux === undefined && !tmuxServerUp(tmux) ? inSessionScope(launch) : launch;
}

export function startSession(deps: SessionDeps = {}): SessionStatus {
  const status = sessionStatus(deps);
  if (status.running) return status;
  if (status.blocked !== null) throw new ApiError(`Cannot start the session: ${status.blocked}`, 409);
  syncAgentView(undefined, deps.agents);
  const tmux = deps.tmux ?? 'tmux';
  const home = sessionHome(deps);
  const now = (deps.now ?? Date.now)();
  const [command = 'metro', ...args] = metroCli(['agent'], deps.metro);
  const tmuxArgs = ['new-session', '-d', '-s', SESSION_NAME, '-c', home, '-x', '200', '-y', '50', command, ...args];
  const launch = tmuxLaunch(deps, tmux, tmuxArgs);
  const run = spawnSync(...launch, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], cwd: '/' });
  recordStart(deps, now, run);
  if (memory.lastError === null) log.info({ home, command: [command, ...args].join(' ') }, 'claude-session: started the Agent SDK runner in tmux');
  return sessionStatus(deps);
}

export function stopSession(deps: SessionDeps = {}, cancelActive = false): SessionStatus {
  if (!stopSdkRunner(sessionHome(deps), cancelActive))
    spawnSync(...asAgent(deps.tmux ?? 'tmux', ['kill-session', '-t', SESSION_NAME]), { stdio: 'ignore' });
  return sessionStatus(deps);
}

export const runnerAlive = (deps: SessionDeps = {}): boolean => sdkAlive(readAgentActivity(sessionHome(deps)));

export const sessionLive = (deps: SessionDeps = {}): boolean => sessionRunning(deps.tmux ?? 'tmux') || runnerAlive(deps);

export function sessionSnapshot(deps: SessionDeps = {}): SessionSnapshot {
  const activity = readAgentActivity(sessionHome(deps));
  return {
    running: sdkAlive(activity) || sessionRunning(deps.tmux ?? 'tmux'),
    activity,
    lastStartedAt: memory.lastStartedAt === null ? null : new Date(memory.lastStartedAt).toISOString(),
  };
}

export function sessionStatus(deps: SessionDeps = {}): SessionStatus {
  return {
    name: SESSION_NAME,
    ...sessionSnapshot(deps),
    autostart: autostartEnabled(deps.agents ?? agentsDir()),
    blocked: sessionBlocked(deps),
    lastError: memory.lastError,
  };
}

function strike(now: number): boolean {
  if (memory.lastStartedAt !== null && now - memory.lastStartedAt < STRIKE_WINDOW_MS) memory.strikes += 1;
  else memory.strikes = 1;
  if (memory.strikes < MAX_STRIKES) return false;
  memory.pausedUntil = now + PAUSE_MS;
  memory.strikes = 0;
  log.warn({ pauseMinutes: PAUSE_MS / 60_000 }, 'claude-session: the session keeps exiting right after starting; not restarting it for a while');
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
  if (found === 'running' || (found === 'absent' && sessionLive(deps))) return 'running';
  const held = holdsBack(deps, r.now);
  if (held !== null) return held;
  if (found === 'stale') {
    log.info({ was: startedVersion(r.agents), now: r.version }, 'claude-session: restarting the session an older metro started, so the new hooks and flags load');
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
      if (outcome === 'started' || outcome === 'restarted') log.info({ outcome }, 'claude-session: the Agent SDK runner is up');
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
