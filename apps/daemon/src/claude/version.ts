import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ApiError } from '@metro-labs/http/api-error';
import { errMsg, log } from '@metro-labs/core/log';
import { sessionRunning, stopSession, type SessionDeps } from './session.js';
import { agentUser, asAgent, claudeBin } from '../agent-user/user.js';
import { CLAUDE_CODE_VERSION, installClaudeCode } from './pinned.js';

const VERSION_RE = /(\d+)\.(\d+)\.(\d+)/;

export interface VersionDeps {
  claude?: string;
  session?: SessionDeps;
}

export interface ClaudeVersion {
  installed: string | null;
  latest: string;
  newer: boolean;
}

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

export function claudeVersion(deps: VersionDeps = {}): ClaudeVersion {
  const installed = located(deps)?.installed ?? null;
  return { installed, latest: CLAUDE_CODE_VERSION, newer: installed !== null && installed !== CLAUDE_CODE_VERSION };
}

function restartIfChanged(changed: boolean, session: SessionDeps): boolean {
  if (!changed || !sessionRunning(session.tmux ?? 'tmux')) return false;
  stopSession(session);
  return true;
}

export function updateClaude(deps: VersionDeps = {}): ClaudeVersion & { restarted: boolean } {
  const found = located(deps);
  if (found === null) throw new ApiError('Claude Code is not installed on this machine', 404);
  try {
    installClaudeCode(found.bin);
  } catch (err) {
    throw new ApiError(errMsg(err), 502);
  }
  const after = claudeVersion(deps);
  const restarted = restartIfChanged(after.installed !== null && after.installed !== found.installed, deps.session ?? {});
  log.info({ from: found.installed, to: after.installed, restarted }, 'claude-version: Claude Code updated');
  return { ...after, restarted };
}

export function pinClaudeCode(deps: VersionDeps = {}): void {
  const found = located(deps);
  if (found === null || found.installed === CLAUDE_CODE_VERSION) return;
  installClaudeCode(found.bin);
  log.info({ from: found.installed, to: located(deps)?.installed ?? null }, 'claude-version: installed the Claude Code version metro was checked with');
}
