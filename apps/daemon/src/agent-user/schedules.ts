import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ApiError } from '@metro-labs/http/api-error';
import { isRecord } from '@metro-labs/core/is-record';
import { errMsg, log } from '@metro-labs/core/log';
import type { AgentUser } from './user.js';

const UNIT_DIR = '/etc/systemd/system';
const defaultBackups = (): string => join(homedir(), '.metro', 'agents');
const DROP_IN = '10-metro-agent.conf';
const OWN_UNITS = /^metro(-claude-\d+)?\.(service|scope)$/;

export type JobKind = 'timer' | 'cron-root' | 'cron-agent';

export interface ScheduledJob {
  id: string;
  kind: JobKind;
  name: string;
  schedule: string;
  command: string;
  runsAs: string;
  next: string | null;
  last: string | null;
  lastResult: string | null;
  usesRoot: boolean;
  converted: boolean;
  problem?: string | null;
}

export interface Runner {
  run: (file: string, args: string[], input?: string) => { status: number | null; stdout: string };
}

const realRunner: Runner = {
  run: (file, args, input) => {
    const done = spawnSync(file, args, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'ignore'], timeout: 20_000 });
    return { status: done.error === undefined ? done.status : null, stdout: done.stdout ?? '' };
  },
};

const ROOT_RE = /(^|[\s="'=:])\/root(?=\/|$|[\s"';:])/;
export const usesRootHome = (text: string): boolean => ROOT_RE.test(text);
export const rehome = (text: string, home: string): string => text.replace(/(^|[\s="'=:])\/root(?=\/|$|[\s"';:])/g, `$1${home}`);

const stamp = (micros: unknown): string | null =>
  typeof micros === 'number' && micros > 0 ? new Date(micros / 1000).toISOString() : null;

function showProps(runner: Runner, unit: string, props: string[]): Record<string, string> {
  const out = runner.run('systemctl', ['show', unit, '--no-pager', ...props.map((p) => `-p${p}`)]).stdout;
  const found: Record<string, string> = {};
  for (const line of out.split('\n')) {
    const at = line.indexOf('=');
    if (at > 0) found[line.slice(0, at)] = line.slice(at + 1);
  }
  return found;
}

export function execArgv(execStart: string): string[] {
  const m = /argv\[\]=(.*?) ;/.exec(execStart);
  return m?.[1] === undefined ? [] : m[1].split(' ').filter((a) => a !== '');
}

export const calendarOf = (timers: string): string =>
  /OnCalendar=([^;]*?) ;/.exec(timers)?.[1]?.trim() ?? /(OnUnitActiveUSec|OnBootUSec|OnActiveUSec)=([^;]*?) ;/.exec(timers)?.[0]?.replace(/ ;$/, '') ?? '';

function listTimers(runner: Runner): Record<string, unknown>[] {
  try {
    const raw: unknown = JSON.parse(runner.run('systemctl', ['list-timers', '--all', '--output=json', '--no-pager']).stdout);
    return Array.isArray(raw) ? raw.filter(isRecord) : [];
  } catch {
    return [];
  }
}

const text = (v: unknown): string => (typeof v === 'string' ? v : '');
const orRoot = (user: string | undefined): string => (user === undefined || user === '' ? 'root' : user);

function timerJob(runner: Runner, t: Record<string, unknown>): ScheduledJob | null {
  const unit = text(t.unit);
  const service = text(t.activates);
  if (unit === '' || service === '' || OWN_UNITS.test(service)) return null;
  const timer = showProps(runner, unit, ['FragmentPath', 'TimersCalendar', 'TimersMonotonic']);
  if (!text(timer.FragmentPath).startsWith(`${UNIT_DIR}/`)) return null;
  const svc = showProps(runner, service, ['ExecStart', 'User', 'Result', 'DropInPaths', 'Environment', 'WorkingDirectory']);
  const command = execArgv(text(svc.ExecStart)).join(' ');
  return {
    id: `timer:${unit}`,
    kind: 'timer',
    name: unit.replace(/\.timer$/, ''),
    schedule: calendarOf(`${text(timer.TimersCalendar)} ${text(timer.TimersMonotonic)}`),
    command,
    runsAs: orRoot(svc.User),
    next: stamp(t.next),
    last: stamp(t.last),
    lastResult: svc.Result ?? null,
    usesRoot: usesRootHome(`${command} ${text(svc.Environment)} ${text(svc.WorkingDirectory)}`),
    converted: text(svc.DropInPaths).includes(DROP_IN),
  };
}

const timerJobs = (runner: Runner): ScheduledJob[] =>
  listTimers(runner).flatMap((t) => {
    const job = timerJob(runner, t);
    return job === null ? [] : [job];
  });

export interface CronLine {
  schedule: string;
  command: string;
}

export function parseCronLine(line: string): CronLine | null {
  const text = line.trim();
  if (text === '' || text.startsWith('#') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(text)) return null;
  if (text.startsWith('@')) {
    const [at = '', ...rest] = text.split(/\s+/);
    return rest.length === 0 ? null : { schedule: at, command: rest.join(' ') };
  }
  const parts = text.split(/\s+/);
  if (parts.length < 6) return null;
  return { schedule: parts.slice(0, 5).join(' '), command: parts.slice(5).join(' ') };
}

const lineId = (kind: JobKind, line: string): string => `${kind}:${createHash('sha256').update(line.trim()).digest('hex').slice(0, 16)}`;

function crontabOf(runner: Runner, user: string): string[] {
  const out = runner.run('crontab', ['-l', '-u', user]);
  return out.status === 0 ? out.stdout.split('\n') : [];
}

function cronJobs(runner: Runner, user: string, kind: JobKind): ScheduledJob[] {
  return crontabOf(runner, user).flatMap((line): ScheduledJob[] => {
    const parsed = parseCronLine(line);
    if (parsed === null) return [];
    return [{
      id: lineId(kind, line),
      kind,
      name: parsed.command.split(/\s+/)[0]?.split('/').pop() ?? 'cron',
      schedule: parsed.schedule,
      command: parsed.command,
      runsAs: user,
      next: null,
      last: null,
      lastResult: null,
      usesRoot: usesRootHome(parsed.command),
      converted: false,
    }];
  });
}

function allJobs(user: AgentUser | null, runner: Runner): ScheduledJob[] {
  return [...timerJobs(runner), ...cronJobs(runner, 'root', 'cron-root'), ...(user === null ? [] : cronJobs(runner, user.name, 'cron-agent'))];
}

const quote = (arg: string): string => `"${arg.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

export function dropInText(user: AgentUser, argv: string[], environment: string): string {
  const env = environment.split(' ').filter((pair) => pair.includes('=') && !pair.startsWith('HOME=') && !pair.startsWith('PATH='));
  return [
    '[Service]',
    `User=${user.name}`,
    `Group=${String(user.gid)}`,
    `WorkingDirectory=${user.home}`,
    `Environment=HOME=${user.home}`,
    `Environment=PATH=${user.home}/.local/bin:/usr/local/bin:/usr/bin:/bin`,
    ...env.map((pair) => `Environment=${quote(rehome(pair, user.home))}`),
    'ExecStart=',
    `ExecStart=${argv.map((a) => quote(rehome(a, user.home))).join(' ')}`,
    '',
  ].join('\n');
}

function convertTimer(job: ScheduledJob, user: AgentUser, runner: Runner): void {
  const unit = job.id.slice('timer:'.length);
  const service = showProps(runner, unit, ['Unit']).Unit ?? unit.replace(/\.timer$/, '.service');
  const svc = showProps(runner, service, ['ExecStart', 'Environment']);
  const argv = execArgv(svc.ExecStart ?? '');
  if (argv.length === 0) throw new ApiError('that timer runs no command metro can read', 400);
  const missing = argv.map((a) => rehome(a, user.home)).find((a) => a.startsWith(`${user.home}/`) && !existsSync(a));
  if (missing !== undefined) throw new ApiError(`${missing} does not exist; move it to the agent first`, 409);
  const dir = join(UNIT_DIR, `${service}.d`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, DROP_IN), dropInText(user, argv, svc.Environment ?? ''), { mode: 0o644 });
  runner.run('systemctl', ['daemon-reload']);
  log.info({ unit, service, user: user.name }, 'schedules: a timer now runs as the agent user');
}

function convertCron(job: ScheduledJob, user: AgentUser, backups: string, runner: Runner): void {
  const lines = crontabOf(runner, 'root');
  const line = lines.find((l) => lineId('cron-root', l) === job.id);
  if (line === undefined) throw new ApiError('that cron line is gone', 404);
  mkdirSync(backups, { recursive: true });
  writeFileSync(join(backups, `crontab-root.${new Date().toISOString().replace(/[:.]/g, '-')}.bak`), lines.join('\n'), { mode: 0o600 });
  const agentLines = crontabOf(runner, user.name).filter((l) => l !== '');
  const moved = runner.run('crontab', ['-u', user.name, '-'], `${[...agentLines, rehome(line, user.home)].join('\n')}\n`);
  if (moved.status !== 0) throw new ApiError("the agent's crontab refused the line", 500);
  const kept = lines.filter((l) => l !== line && l !== '');
  runner.run('crontab', ['-u', 'root', '-'], `${kept.join('\n')}\n`);
  log.info({ user: user.name }, "schedules: a root cron line moved to the agent's crontab");
}

function toAgent(job: ScheduledJob, user: AgentUser, backups: string, runner: Runner): void {
  if (job.kind === 'timer') convertTimer(job, user, runner);
  else if (job.kind === 'cron-root') convertCron(job, user, backups, runner);
  else throw new ApiError('that job already runs as the agent', 400);
}

const problems = new Map<string, string>();

const needsAgent = (job: ScheduledJob): boolean => job.kind !== 'cron-agent' && job.runsAs === 'root' && job.usesRoot;

function tryAgent(job: ScheduledJob, user: AgentUser, backups: string, runner: Runner): boolean {
  try {
    toAgent(job, user, backups, runner);
    problems.delete(job.id);
    return true;
  } catch (err) {
    problems.set(job.id, errMsg(err));
    log.warn({ job: job.name, err: errMsg(err) }, 'schedules: a job still pointing into /root could not be switched to the agent user');
    return false;
  }
}

export function convertRootJobs(user: AgentUser | null, backups = defaultBackups(), runner: Runner = realRunner): number {
  if (user === null) return 0;
  const pending = allJobs(user, runner).filter(needsAgent);
  return pending.filter((job) => tryAgent(job, user, backups, runner)).length;
}

export const listSchedules = (user: AgentUser | null, runner: Runner = realRunner): ScheduledJob[] =>
  allJobs(user, runner)
    .filter((job) => job.runsAs !== 'root' || job.usesRoot)
    .map((job) => ({ ...job, problem: problems.get(job.id) ?? null }));

export function retrySchedule(id: string, user: AgentUser | null, backups = defaultBackups(), runner: Runner = realRunner): ScheduledJob[] {
  if (user === null) throw new ApiError('Claude Code does not run as its own user on this machine', 409);
  const job = allJobs(user, runner).find((j) => j.id === id);
  if (job === undefined) throw new ApiError('no such scheduled job', 404);
  if (needsAgent(job)) toAgent(job, user, backups, runner);
  problems.delete(id);
  return listSchedules(user, runner);
}
