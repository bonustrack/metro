import { createHash } from 'node:crypto';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { errMsg, log } from '@metro-labs/core/log';
import { existsSync, readFileSync } from '../agent-user/agent-fs.js';
import { editCrontab, withBlock } from '../agent-user/crontab.js';
import { writeHomeText } from '../agent-user/home-fs.js';
import { listSchedules, realRunner, type Runner } from '../agent-user/schedules.js';
import { agentPath, agentUser, type AgentUser } from '../agent-user/user.js';

const BEGIN = '# metro memory routine: begin';
const END = '# metro memory routine: end';
const OWN_JOB = /memory/i;
const HOUR = 0;

export type MemoryJobState = 'scheduled' | 'own' | 'off' | 'unavailable';

export interface MemoryJob {
  state: MemoryJobState;
  job: string | null;
}

export interface MemoryJobDeps {
  user?: AgentUser | null;
  runner?: Runner;
  cli?: string;
  port?: string;
  seed?: string;
}

let last: MemoryJob = { state: 'unavailable', job: null };

export const memoryJobStatus = (): MemoryJob => ({ ...last });

export const launcherPath = (user: AgentUser): string => join(user.home, '.metro', 'bin', 'memory-routine');
const logPath = (user: AgentUser): string => join(user.home, '.metro', 'memory-routine.log');
const quoted = (text: string): string => `'${text.replace(/'/g, '\'\\\'\'')}'`;

export function launcherText(user: AgentUser, cli: string, port: string): string {
  return [
    '#!/bin/sh',
    `PATH=${quoted(agentPath(user))}`,
    'export PATH',
    ...(port === '' ? [] : [`METRO_WEBHOOK_PORT=${quoted(port)}`, 'export METRO_WEBHOOK_PORT']),
    'cd "$HOME" || exit 1',
    `exec node ${quoted(cli)} memory`,
    '',
  ].join('\n');
}

export function cronLine(user: AgentUser, seed: string): string {
  const minute = parseInt(createHash('sha256').update(seed).digest('hex').slice(0, 8), 16) % 60;
  return `${String(minute)} ${String(HOUR)} * * * ${launcherPath(user)} >> ${logPath(user)} 2>&1`;
}

function ownJob(user: AgentUser, runner: Runner): string | null {
  const launcher = launcherPath(user);
  const found = listSchedules(user, runner).find((job) => !job.command.includes(launcher) && OWN_JOB.test(`${job.name} ${job.command}`));
  return found?.name ?? null;
}

function placeLauncher(path: string, text: string): void {
  if (existsSync(path) && readFileSync(path, 'utf8') === text) return;
  writeHomeText(path, text, 0o755);
}

const envText = (name: string): string => process.env[name]?.trim() ?? '';

function resolved(deps: MemoryJobDeps): Required<MemoryJobDeps> {
  return {
    user: deps.user === undefined ? agentUser() : deps.user,
    runner: deps.runner ?? realRunner,
    cli: deps.cli ?? envText('METRO_CLI_BIN'),
    port: deps.port ?? envText('METRO_WEBHOOK_PORT'),
    seed: deps.seed ?? hostname(),
  };
}

export function ensureMemoryJob(on: boolean, deps: MemoryJobDeps = {}): MemoryJob {
  const { user, runner, cli, port, seed } = resolved(deps);
  if (user === null || cli === '') {
    last = { state: 'unavailable', job: null };
    return memoryJobStatus();
  }
  const own = on ? ownJob(user, runner) : null;
  const scheduled = on && own === null;
  if (scheduled) placeLauncher(launcherPath(user), launcherText(user, cli, port));
  const line = cronLine(user, seed);
  const changed = editCrontab(user, runner, (lines) => withBlock(lines, BEGIN, END, scheduled ? [line] : [], 'end'));
  last = { state: scheduled ? 'scheduled' : own === null ? 'off' : 'own', job: own };
  if (changed) log.info({ ...last }, 'memory-routine: updated the daily memory job');
  return memoryJobStatus();
}

export function tryMemoryJob(on: boolean): void {
  try {
    ensureMemoryJob(on);
  } catch (err) {
    log.warn({ err: errMsg(err) }, 'memory-routine: could not set up the daily memory job');
  }
}
