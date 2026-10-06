import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { isRecord } from '@metro-labs/core/is-record';
import type { RunnerActivity } from '@metro-labs/core/runner-activity';
import { ApiError } from '@metro-labs/http/api-error';
import { asAgent } from '../agent-user/user.js';
import { readAgentActivity } from './runner-activity.js';

function identity(pid: number): { started: string; zombie: boolean } | null {
  try {
    const stat = readFileSync(`/proc/${String(pid)}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return { started: fields[19] ?? '', zombie: fields[0] === 'Z' };
  } catch {
    return null;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return isRecord(err) && err.code === 'EPERM';
  }
}

export function sdkAlive(activity: RunnerActivity | null): activity is RunnerActivity {
  if (activity === null) return false;
  const found = identity(activity.pid);
  if (found?.zombie === true) return false;
  if (activity.procStart !== undefined && found !== null && activity.procStart !== found.started) return false;
  if (activity.procStart === undefined && activity.phase === 'stopped') return false;
  return pidAlive(activity.pid);
}

function assertIdentity(activity: RunnerActivity): void {
  const found = identity(activity.pid);
  if (activity.pid === process.pid || activity.procStart === undefined || activity.procStart !== found?.started)
    throw new ApiError('The Agent SDK is still running outside tmux, but its process identity cannot be verified safely. Stop that metro agent process from its terminal.', 503);
}

export function stopSdkRunner(home: string, cancelActive = false): boolean {
  const activity = readAgentActivity(home);
  if (!sdkAlive(activity)) return false;
  assertIdentity(activity);
  const signal = cancelActive && activity.cancelSignal === 'SIGUSR2' ? '-USR2' : '-TERM';
  const run = spawnSync(...asAgent('kill', [signal, String(activity.pid)]), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if ((run.error !== undefined || run.status !== 0) && sdkAlive(activity))
    throw new ApiError(`The Agent SDK could not be stopped: ${run.error?.message ?? run.stderr.trim()}`, 503);
  return true;
}
