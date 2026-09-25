import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readRange, statSync } from './agent-fs.js';
import { ApiError } from '@metro-labs/http/api-error';
import { log } from '@metro-labs/core/log';
import { listSchedules, realRunner, showProps, type Runner, type ScheduledJob } from './schedules.js';
import { asUser, type AgentUser } from './user.js';

const LOG_LINES = 80;
const TAIL_BYTES = 64 * 1024;

export interface JobDetail extends ScheduledJob {
  definition: string;
  logs: string;
  logSource: string | null;
  script: { path: string; text: string } | null;
}

const SCRIPT_MAX = 64 * 1024;

function textFile(path: string): string | null {
  try {
    const st = statSync(path);
    if (!st.isFile() || st.size > SCRIPT_MAX) return null;
    const text = readFileSync(path, 'utf8');
    return text.includes('\u0000') ? null : text;
  } catch {
    return null;
  }
}

export function scriptOf(command: string): { path: string; text: string } | null {
  const words = command.split(/\s+/).filter((w) => w.startsWith('/') && !w.includes('>'));
  for (const path of words.slice(0, 3)) {
    const text = textFile(path);
    if (text !== null) return { path, text };
  }
  return null;
}

function findJob(id: string, user: AgentUser | null, runner: Runner): ScheduledJob {
  const job = listSchedules(user, runner).find((j) => j.id === id);
  if (job === undefined) throw new ApiError('no such scheduled job', 404);
  return job;
}

const serviceOf = (unit: string, runner: Runner): string => showProps(runner, unit, ['Unit']).Unit ?? unit.replace(/\.timer$/, '.service');

export function logFileOf(command: string): string | null {
  const m = /(?:^|\s)(?:>>|>)\s*(\/\S+)/.exec(command);
  return m?.[1] ?? null;
}

function tail(path: string): string {
  const size = statSync(path).size;
  const start = Math.max(0, size - TAIL_BYTES);
  return readRange(path, start, size - start).toString('utf8').split('\n').slice(-LOG_LINES).join('\n');
}

function timerDetail(job: ScheduledJob, runner: Runner): JobDetail {
  const unit = job.id.slice('timer:'.length);
  const service = serviceOf(unit, runner);
  return {
    ...job,
    definition: runner.run('systemctl', ['cat', unit, service, '--no-pager']).stdout,
    logs: runner.run('journalctl', ['-u', service, '-n', String(LOG_LINES), '--no-pager', '-o', 'short-iso']).stdout,
    logSource: `journalctl -u ${service}`,
    script: scriptOf(job.command),
  };
}

function cronDetail(job: ScheduledJob): JobDetail {
  const file = logFileOf(job.command);
  const readable = file !== null && existsSync(file) && statSync(file).isFile();
  return {
    ...job,
    definition: `${job.schedule} ${job.command}`,
    logs: readable ? tail(file) : '',
    logSource: file,
    script: scriptOf(job.command),
  };
}

export function scheduleDetail(id: string, user: AgentUser | null, runner: Runner = realRunner): JobDetail {
  const job = findJob(id, user, runner);
  return job.kind === 'timer' ? timerDetail(job, runner) : cronDetail(job);
}

export function runNow(id: string, user: AgentUser | null, runner: Runner = realRunner): JobDetail {
  const job = findJob(id, user, runner);
  if (job.runsAs === 'root') throw new ApiError('this job still runs as root; switch it to the agent first', 409);
  if (job.kind === 'timer') runner.run('systemctl', ['start', '--no-block', serviceOf(job.id.slice('timer:'.length), runner)]);
  else {
    if (user === null) throw new ApiError('Claude Code does not run as its own user on this machine', 409);
    const [file, args] = asUser(user, 'sh', ['-c', `cd "$HOME" && ${job.command}`]);
    const child = spawn(file, args, { detached: true, stdio: 'ignore', cwd: '/' });
    child.unref();
  }
  log.info({ job: job.name }, 'schedules: run now, from the page');
  return scheduleDetail(id, user, runner);
}
