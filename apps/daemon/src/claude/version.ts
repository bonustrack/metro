import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ApiError } from '@metro-labs/http/api-error';
import { errMsg, log } from '@metro-labs/core/log';
import { isRecord } from '@metro-labs/core/is-record';
import { sessionRunning, stopSession, type SessionDeps } from './session.js';
import { agentUser, asAgent, claudeBin } from '../agent-user/user.js';

const LATEST_URL = 'https://registry.npmjs.org/@anthropic-ai/claude-code/latest';
const VERSION_RE = /(\d+)\.(\d+)\.(\d+)/;
const CACHE_MS = 10 * 60_000;
const INSTALL_TIMEOUT_MS = 5 * 60_000;
const TAIL = 400;

export interface VersionDeps {
  claude?: string;
  fetchImpl?: typeof fetch;
  session?: SessionDeps;
  now?: () => number;
}

export interface ClaudeVersion {
  installed: string | null;
  latest: string | null;
  newer: boolean;
}

let cached: { latest: string | null; at: number } | null = null;

function candidates(deps: VersionDeps): string[] {
  if (deps.claude !== undefined) return [deps.claude];
  return agentUser() === null ? ['claude', join(homedir(), '.local', 'bin', 'claude')] : [claudeBin()];
}

const parse = (text: string): string | null => {
  const m = VERSION_RE.exec(text);
  return m === null ? null : `${m[1] ?? ''}.${m[2] ?? ''}.${m[3] ?? ''}`;
};

function probe(bin: string): string | null {
  const run = spawnSync(...asAgent(bin, ['--version']), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  return run.error === undefined && run.status === 0 && typeof run.stdout === 'string' ? parse(run.stdout) : null;
}

function located(deps: VersionDeps): { bin: string; installed: string } | null {
  for (const bin of candidates(deps)) {
    const installed = probe(bin);
    if (installed !== null) return { bin, installed };
  }
  return null;
}

export function newerThan(a: string, b: string): boolean {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    const d = (left[i] ?? 0) - (right[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return false;
}

export async function latestClaudeVersion(deps: VersionDeps = {}): Promise<string | null> {
  const now = (deps.now ?? Date.now)();
  if (cached !== null && now - cached.at < CACHE_MS) return cached.latest;
  const fetchImpl = deps.fetchImpl ?? fetch;
  let latest: string | null = null;
  try {
    const res = await fetchImpl(LATEST_URL, { headers: { accept: 'application/json' }, redirect: 'manual' });
    const body: unknown = res.ok ? await res.json() : null;
    latest = isRecord(body) && typeof body.version === 'string' ? parse(body.version) : null;
  } catch (err) {
    log.warn({ err: errMsg(err) }, 'claude-version: could not read the latest version from npm');
  }
  cached = { latest, at: now };
  return latest;
}

export function forgetClaudeVersion(): void {
  cached = null;
}

export async function claudeVersion(deps: VersionDeps = {}): Promise<ClaudeVersion> {
  const installed = located(deps)?.installed ?? null;
  const latest = await latestClaudeVersion(deps);
  return { installed, latest, newer: installed !== null && latest !== null && newerThan(latest, installed) };
}

function install(bin: string): void {
  const run = spawnSync(...asAgent(bin, ['install', 'latest']), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: INSTALL_TIMEOUT_MS });
  if (run.error !== undefined) throw new ApiError(`claude install latest failed: ${errMsg(run.error)}`, 502);
  if (run.status === 0) return;
  const said = `${run.stderr ?? ''}${run.stdout ?? ''}`.trim().slice(-TAIL);
  throw new ApiError(`claude install latest failed: ${said}`, 502);
}

function restartIfChanged(changed: boolean, session: SessionDeps): boolean {
  if (!changed || !sessionRunning(session.tmux ?? 'tmux')) return false;
  stopSession(session);
  return true;
}

export async function updateClaude(deps: VersionDeps = {}): Promise<ClaudeVersion & { restarted: boolean }> {
  const found = located(deps);
  if (found === null) throw new ApiError('Claude Code is not installed on this machine', 404);
  install(found.bin);
  forgetClaudeVersion();
  const after = await claudeVersion(deps);
  const restarted = restartIfChanged(after.installed !== null && after.installed !== found.installed, deps.session ?? {});
  log.info({ from: found.installed, to: after.installed, restarted }, 'claude-version: Claude Code updated');
  return { ...after, restarted };
}
