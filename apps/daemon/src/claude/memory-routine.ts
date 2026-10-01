import { join } from 'node:path';
import { errMsg, log } from '@metro-labs/core/log';
import { existsSync, readFileSync } from '../agent-user/agent-fs.js';
import { readCrontab, withBlock, writeCrontab } from '../agent-user/crontab.js';
import { writeHomeText } from '../agent-user/home-fs.js';
import { listSchedules, parseCronLine, realRunner, type Runner } from '../agent-user/schedules.js';
import { agentPath, agentUser, type AgentUser } from '../agent-user/user.js';

const BEGIN = '# metro memory routine: begin';
const END = '# metro memory routine: end';
const REPLACED = '# replaced by memory-routine: ';
const OWN_JOB = /memory/i;
const SCHEDULE = '0 0,12 * * *';

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
}

let last: MemoryJob = { state: 'unavailable', job: null };

export const memoryJobStatus = (): MemoryJob => ({ ...last });

export const launcherPath = (user: AgentUser): string => join(user.home, '.metro', 'bin', 'memory-routine');
export const skillPath = (user: AgentUser): string => join(user.home, '.claude', 'skills', 'memory', 'SKILL.md');
const logPath = (user: AgentUser): string => join(user.home, '.metro', 'memory-routine.log');
const quoted = (text: string): string => `'${text.replace(/'/g, '\'\\\'\'')}'`;

export function launcherText(user: AgentUser, cli: string, port: string): string {
  return [
    '#!/bin/sh',
    `PATH=${quoted(agentPath(user))}`,
    'export PATH',
    ...(port === '' ? [] : [`METRO_WEBHOOK_PORT=${quoted(port)}`, 'export METRO_WEBHOOK_PORT']),
    'cd "$HOME" || exit 1',
    `exec node ${quoted(cli)} memory "$@"`,
    '',
  ].join('\n');
}

export const cronLine = (user: AgentUser): string => `${SCHEDULE} ${launcherPath(user)} ${skillPath(user)} >> ${logPath(user)} 2>&1`;

const commandName = (command: string): string => command.split(/\s+/)[0]?.split('/').pop() ?? 'cron';

const ownCommand = (user: AgentUser, line: string): string | null => {
  const parsed = parseCronLine(line);
  return parsed === null || parsed.command.includes(launcherPath(user)) || !OWN_JOB.test(parsed.command) ? null : parsed.command;
};

const replaces = (user: AgentUser, line: string): boolean => OWN_JOB.test(commandName(ownCommand(user, line) ?? ''));

function ownJob(user: AgentUser, runner: Runner, lines: string[]): string | null {
  const cron = lines.flatMap((line) => {
    const command = ownCommand(user, line);
    return command === null || replaces(user, line) ? [] : [commandName(command)];
  });
  const timers = listSchedules(null, runner).filter((job) => job.runsAs === user.name && OWN_JOB.test(`${job.name} ${job.command}`));
  return cron[0] ?? timers[0]?.name ?? null;
}

const restored = (line: string): string => (line.startsWith(REPLACED) ? line.slice(REPLACED.length) : line);

function marked(user: AgentUser, lines: string[], on: boolean, scheduled: boolean): string[] {
  if (!on) return lines.map(restored);
  return lines.map((l) => (scheduled && replaces(user, l) ? `${REPLACED}${l}` : l));
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
  };
}

const stateOf = (scheduled: boolean, own: string | null): MemoryJobState => {
  if (scheduled) return 'scheduled';
  return own === null ? 'off' : 'own';
};

export function ensureMemoryJob(on: boolean, deps: MemoryJobDeps = {}): MemoryJob {
  const { user, runner, cli, port } = resolved(deps);
  if (user === null || cli === '') {
    last = { state: 'unavailable', job: null };
    return memoryJobStatus();
  }
  const lines = readCrontab(user, runner);
  const own = on ? ownJob(user, runner, lines) : null;
  const scheduled = on && own === null;
  const launcher = launcherPath(user);
  if (scheduled) placeLauncher(launcher, launcherText(user, cli, port));
  const kept = marked(user, lines, on, scheduled);
  const next = withBlock(kept, BEGIN, END, scheduled ? [cronLine(user)] : [], 'end', (l) => l.includes(launcher));
  const changed = writeCrontab(user, runner, lines, next);
  last = { state: stateOf(scheduled, own), job: own };
  if (changed) log.info({ ...last, rewritten: kept.filter((l, i) => l !== lines[i]) }, 'memory-routine: updated the memory job');
  return memoryJobStatus();
}

export function tryMemoryJob(on: boolean): void {
  try {
    ensureMemoryJob(on);
  } catch (err) {
    log.warn({ err: errMsg(err) }, 'memory-routine: could not set up the daily memory job');
  }
}
