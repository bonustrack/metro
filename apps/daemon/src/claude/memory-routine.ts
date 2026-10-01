import { createHash } from 'node:crypto';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { errMsg, log } from '@metro-labs/core/log';
import { existsSync, readFileSync } from '../agent-user/agent-fs.js';
import { readCrontab, withBlock, writeCrontab } from '../agent-user/crontab.js';
import { writeHomeText } from '../agent-user/home-fs.js';
import { listSchedules, parseCronLine, realRunner, type Runner } from '../agent-user/schedules.js';
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

const commandName = (command: string): string => command.split(/\s+/)[0]?.split('/').pop() ?? 'cron';

function ownJob(user: AgentUser, runner: Runner, lines: string[]): string | null {
  const launcher = launcherPath(user);
  const cron = lines.flatMap((line) => {
    const parsed = parseCronLine(line);
    return parsed === null || parsed.command.includes(launcher) || !OWN_JOB.test(parsed.command) ? [] : [commandName(parsed.command)];
  });
  const timers = listSchedules(null, runner).filter((job) => job.runsAs === user.name && OWN_JOB.test(`${job.name} ${job.command}`));
  return cron[0] ?? timers[0]?.name ?? null;
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

const stateOf = (scheduled: boolean, own: string | null): MemoryJobState => {
  if (scheduled) return 'scheduled';
  return own === null ? 'off' : 'own';
};

export function ensureMemoryJob(on: boolean, deps: MemoryJobDeps = {}): MemoryJob {
  const { user, runner, cli, port, seed } = resolved(deps);
  if (user === null || cli === '') {
    last = { state: 'unavailable', job: null };
    return memoryJobStatus();
  }
  const lines = readCrontab(user, runner);
  const own = on ? ownJob(user, runner, lines) : null;
  const scheduled = on && own === null;
  const launcher = launcherPath(user);
  if (scheduled) placeLauncher(launcher, launcherText(user, cli, port));
  const next = withBlock(lines, BEGIN, END, scheduled ? [cronLine(user, seed)] : [], 'end', (l) => l.includes(launcher));
  const changed = writeCrontab(user, runner, lines, next);
  last = { state: stateOf(scheduled, own), job: own };
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
