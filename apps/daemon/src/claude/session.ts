import { spawn, spawnSync } from 'node:child_process';
import { realpathSync } from '../agent-user/agent-fs.js';
import { ApiError } from '@metro-labs/http/api-error';
import type { RunnerActivity } from '@metro-labs/core/runner-activity';
import { readAgentActivity } from './runner-activity.js';
import { sdkAlive, stopSdkRunner } from './runner-process.js';
import { continueArgs, sdkPending } from './session-continuity.js';
import { syncAgentView } from '../agent-user/view.js';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { errMsg, log } from '@metro-labs/core/log';
import { isRecord } from '@metro-labs/core/is-record';
import { readJson, writeJson } from '@metro-labs/core/secure-fs';
import { METRO_VERSION } from '@metro-labs/core/version';
import { agentsDir, listAgentFiles } from '../agents/files.js';
import { notReady, readModelConfig, routedConnection } from '../gateway/model-config.js';
import { claudeDir, listClaudeProjects } from './files.js';
import { harnessRunner, isHarnessRunner, sdkAllowed, SDK_NEEDS_KEY, type HarnessRunner } from './runner.js';
import { claudeAccount, claudeInstalled } from './login.js';
import { trustFolder } from './onboarding.js';
import { inSessionScope } from './memory.js';
import { runningAsRoot } from '../metro-user/privilege.js';
import { agentExtraEnv, agentUser, agentUserExpected, agentViewDir, asAgent, claudeHome } from '../agent-user/user.js';

function sessionEnv(): Record<string, string> {
  const user = agentUser();
  if (user === null) return {};
  const port = process.env.METRO_WEBHOOK_PORT?.trim() ?? '';
  return { ...agentExtraEnv(), METRO_AGENTS_DIR: agentViewDir(user), ...(port === '' ? {} : { METRO_WEBHOOK_PORT: port }) };
}

const SESSION_NAME = 'metro';
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
  runner?: string[];
  home?: string;
  agents?: string;
  signedIn?: () => boolean;
  now?: () => number;
  version?: string;
  prepare?: (runner: HarnessRunner) => Promise<void>;
}

export interface SessionStatus {
  name: string;
  running: boolean;
  runner?: HarnessRunner;
  activity?: RunnerActivity | null;
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

function realDir(dir: string): string {
  try {
    return realpathSync(dir);
  } catch {
    return dir;
  }
}

const encodedCwd = (dir: string): string => dir.replace(/[^A-Za-z0-9]/g, '-');

export function hasConversation(home: string, dir = claudeDir()): boolean {
  const cwd = realDir(home);
  const folder = encodedCwd(cwd);
  return listClaudeProjects(dir).some(
    (project) => project.sessions > 0 && (project.id === folder || (project.cwd !== null && realDir(project.cwd) === cwd)),
  );
}

export function metroCli(args: string[], fixed?: string[]): string[] {
  const bin = process.env.METRO_CLI_BIN?.trim() ?? '';
  const runtime = agentUser() === null ? process.execPath : 'node';
  const base = fixed ?? (bin === '' ? ['metro', ...args] : [runtime, bin, ...args]);
  const env = Object.entries(sessionEnv()).map(([k, v]) => `${k}=${v}`);
  return env.length === 0 || fixed !== undefined ? base : ['env', ...env, ...base];
}

const sessionHome = (deps: SessionDeps): string => deps.home ?? claudeHome() ?? homedir();

export function sessionRunner(deps: SessionDeps = {}): HarnessRunner {
  const agents = deps.agents ?? agentsDir();
  const runner = readState(agents).runner;
  return isHarnessRunner(runner) ? runner : harnessRunner(agents);
}

export function assertSessionStopped(deps: SessionDeps = {}): void {
  if (sessionLive(deps)) throw new ApiError('The session is running. Let it finish its work, stop it, then change its runner, permissions or prompt and start it again.', 409);
}

export function assertSdkDrained(deps: SessionDeps = {}): void {
  if (sdkPending(sessionHome(deps)) !== 0)
    throw new ApiError('The Agent SDK still has chat messages it has not answered, or its saved state cannot be read. Start it so it answers them (fix the Model page first if it cannot start), stop it, then switch runners.', 409);
}

let changing = false;

export async function withSessionChange<T>(run: () => Promise<T>): Promise<T> {
  if (changing) throw new ApiError('A session change is already being prepared. Try again when it finishes.', 409);
  changing = true;
  try {
    return await run();
  } finally {
    changing = false;
  }
}

export async function prepareSessionRunner(runner: HarnessRunner, deps: SessionDeps = {}): Promise<void> {
  if (deps.prepare !== undefined) return deps.prepare(runner);
  const [bin = 'metro', ...args] = metroCli(['agent', '--prepare', runner]);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(...asAgent(bin, args), { stdio: ['ignore', 'ignore', 'pipe'], timeout: 16 * 60_000 });
    let error = '';
    child.stderr.on('data', (chunk: Buffer) => { error = (error + chunk.toString()).slice(-2000); });
    child.on('error', (err) => { reject(new ApiError(`Runner preparation failed: ${errMsg(err)}`, 503)); });
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new ApiError(`Runner preparation failed. The runner choice was not changed. ${error.trim()}`, 503));
    });
  });
}

function metroCommand(deps: SessionDeps, home: string): string[] {
  if (harnessRunner(deps.agents ?? agentsDir()) === 'sdk') return metroCli(['agent'], deps.runner);
  return [...metroCli(['claude'], deps.metro), ...continueArgs(home, claudeDir(), deps.agents)];
}

function credentialReady(deps: SessionDeps): string | null {
  const signedIn = deps.signedIn ?? (() => claudeAccount().signedIn);
  if (signedIn()) return null;
  try {
    const cfg = readModelConfig(deps.agents ?? agentsDir());
    const conn = routedConnection(cfg);
    if (conn !== null && notReady(cfg) === null && (conn.provider !== 'anthropic' || conn.apiKey !== '')) return null;
  } catch (err) {
    return `the Model page is not readable (${errMsg(err)})`;
  }
  return 'Claude Code is not signed in and the Model page routes nowhere yet';
}

const agentUserMissing = (deps: SessionDeps): boolean =>
  deps.metro === undefined && agentUserExpected() && agentUser() === null;

const ROOT_REFUSED = 'Metro runs as root; reinstall it as the metro user';

export function sessionBlocked(deps: SessionDeps = {}): string | null {
  if (runningAsRoot()) return ROOT_REFUSED;
  const agents = deps.agents ?? agentsDir();
  if (harnessRunner(agents) === 'sdk' && !sdkAllowed(agents)) return SDK_NEEDS_KEY;
  if (listAgentFiles(agents).length === 0) return 'no agent on this machine yet';
  return launchBlocked(deps);
}

function launchBlocked(deps: SessionDeps): string | null {
  if (agentUserMissing(deps))
    return 'Claude Code runs as the user agent here, and that user is not ready yet; see the log';
  if (deps.metro === undefined && !claudeInstalled()) return 'Claude Code is not installed on this machine';
  if (!tmuxOk(deps.tmux ?? 'tmux', ['-V'])) return 'tmux is not installed on this machine';
  return credentialReady(deps);
}

function capturePane(tmux: string): string {
  const run = spawnSync(...asAgent(tmux, ['capture-pane', '-p', '-t', SESSION_NAME]), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  return run.error === undefined && run.status === 0 ? run.stdout : '';
}

function noteLaunchLines(pane: string, seen: Set<string>): void {
  for (const line of pane.split('\n').map((l) => l.trim()))
    if (line.startsWith('metro claude:') && !seen.has(line)) {
      seen.add(line);
      log.info({ line }, 'claude-session: metro claude said');
    }
}

function confirmChannels(tmux: string, until: number): void {
  const seen = new Set<string>();
  let confirmed = false;
  const tick = (): void => {
    const pane = capturePane(tmux);
    noteLaunchLines(pane, seen);
    if (!confirmed && pane.includes(WARNING) && pane.includes('server:metro')) {
      spawnSync(...asAgent(tmux, ['send-keys', '-t', SESSION_NAME, 'Enter']), { stdio: 'ignore' });
      log.info('claude-session: confirmed the development channels dialog for server:metro');
      confirmed = true;
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
  const agents = deps.agents ?? agentsDir();
  writeState(agents, { version: deps.version ?? METRO_VERSION, runner: harnessRunner(agents) });
  confirmChannels(tmux, now + CONFIRM_WAIT_MS);
}

function tmuxLaunch(deps: SessionDeps, tmux: string, args: string[]): [string, string[]] {
  const launch = asAgent(tmux, args);
  return deps.tmux === undefined && !tmuxServerUp(tmux) ? inSessionScope(launch) : launch;
}

export function startSession(deps: SessionDeps = {}): SessionStatus {
  if (changing) throw new ApiError('A runner change is being prepared. Start the session after it finishes.', 409);
  const status = sessionStatus(deps);
  if (status.running) return status;
  if (status.blocked !== null) throw new ApiError(`Cannot start the session: ${status.blocked}`, 409);
  syncAgentView(undefined, deps.agents);
  const tmux = deps.tmux ?? 'tmux';
  const home = sessionHome(deps);
  const now = (deps.now ?? Date.now)();
  const trusted = trustFolder(home);
  const [command = 'metro', ...args] = metroCommand(deps, home);
  const tmuxArgs = ['new-session', '-d', '-s', SESSION_NAME, '-c', home, '-x', '200', '-y', '50', command, ...args];
  const launch = tmuxLaunch(deps, tmux, tmuxArgs);
  const run = spawnSync(...launch, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], cwd: '/' });
  recordStart(deps, tmux, now, run);
  if (memory.lastError === null) log.info({ home, trusted, command: [command, ...args].join(' ') }, 'claude-session: started Claude Code in tmux');
  return sessionStatus(deps);
}

export function stopSession(deps: SessionDeps = {}): SessionStatus {
  spawnSync(...asAgent(deps.tmux ?? 'tmux', ['kill-session', '-t', SESSION_NAME]), { stdio: 'ignore' });
  stopSdkRunner(sessionHome(deps));
  return sessionStatus(deps);
}

export const sessionLive = (deps: SessionDeps = {}): boolean =>
  sessionRunning(deps.tmux ?? 'tmux') || sdkAlive(readAgentActivity(sessionHome(deps)));

export function sessionStatus(deps: SessionDeps = {}): SessionStatus {
  const activity = readAgentActivity(sessionHome(deps));
  const sdk = sdkAlive(activity);
  return {
    name: SESSION_NAME,
    running: sessionRunning(deps.tmux ?? 'tmux') || sdk,
    runner: sdk ? 'sdk' : sessionRunner(deps),
    activity,
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
  if (changing) return 'blocked';
  const found = situation(r);
  if (found === 'running' || (found === 'absent' && sessionLive(deps))) return 'running';
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
