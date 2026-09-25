import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { isRecord } from '@metro-labs/core/is-record';
import type { AgentUser } from './user.js';
import { helperRun } from './unit-files.js';

const UNIT_DIR = '/etc/systemd/system';
const OWN_UNITS = /^metro(-claude-\d+)?\.(service|scope)$/;

export type JobKind = 'timer' | 'cron-agent';

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
}

export interface Runner {
  run: (file: string, args: string[], input?: string) => { status: number | null; stdout: string };
}

export const realRunner: Runner = {
  run: (file, args, input) => {
    const viaHelper = helperRun(file, args, input);
    if (viaHelper !== null) return viaHelper;
    const done = spawnSync(file, args, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'ignore'], timeout: 20_000 });
    return { status: done.error === undefined ? done.status : null, stdout: done.stdout ?? '' };
  },
};

const stamp = (micros: unknown): string | null =>
  typeof micros === 'number' && micros > 0 ? new Date(micros / 1000).toISOString() : null;

export function showProps(runner: Runner, unit: string, props: string[]): Record<string, string> {
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
  const svc = showProps(runner, service, ['ExecStart', 'User', 'Result']);
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
    }];
  });
}

function allJobs(user: AgentUser | null, runner: Runner): ScheduledJob[] {
  return [...timerJobs(runner), ...(user === null ? [] : cronJobs(runner, user.name, 'cron-agent'))];
}

export const listSchedules = (user: AgentUser | null, runner: Runner = realRunner): ScheduledJob[] =>
  allJobs(user, runner).filter((job) => job.runsAs !== 'root');
