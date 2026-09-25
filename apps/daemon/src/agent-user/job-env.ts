import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { log } from '@metro-labs/core/log';
import { writeHomeText } from './home-fs.js';
import { listSchedules, realRunner, showProps, type Runner } from './schedules.js';
import type { AgentUser } from './user.js';

const UNIT_DIR = '/etc/systemd/system';
const DROP_IN = '11-metro-vault.conf';
const BEGIN = '# metro vault: begin';
const END = '# metro vault: end';

export const jobEnvFile = (user: AgentUser): string => join(user.home, '.metro', 'vault.env');

export function withCronEnv(lines: string[], env: Record<string, string>): string[] {
  const start = lines.indexOf(BEGIN);
  const stop = lines.indexOf(END);
  const rest = start >= 0 && stop > start ? [...lines.slice(0, start), ...lines.slice(stop + 1)] : lines;
  const kept = rest.filter((l) => l !== '');
  const block = Object.entries(env).map(([k, v]) => `${k}=${v}`);
  return block.length === 0 ? kept : [BEGIN, ...block, END, ...kept];
}

function setCronEnv(user: AgentUser, env: Record<string, string>, runner: Runner): void {
  const out = runner.run('crontab', ['-l', '-u', user.name]);
  const lines = out.status === 0 ? out.stdout.split('\n') : [];
  const next = withCronEnv(lines, env);
  if (next.join('\n') === lines.filter((l) => l !== '').join('\n')) return;
  runner.run('crontab', ['-u', user.name, '-'], next.length === 0 ? '' : `${next.join('\n')}\n`);
}

function setTimerEnv(user: AgentUser, on: boolean, runner: Runner): void {
  let changed = false;
  for (const job of listSchedules(user, runner)) {
    if (job.kind !== 'timer' || job.runsAs !== user.name) continue;
    const unit = job.id.slice('timer:'.length);
    const service = showProps(runner, unit, ['Unit']).Unit ?? unit.replace(/\.timer$/, '.service');
    const file = join(UNIT_DIR, `${service}.d`, DROP_IN);
    if (on) {
      mkdirSync(join(UNIT_DIR, `${service}.d`), { recursive: true });
      writeFileSync(file, `[Service]\nEnvironmentFile=-${jobEnvFile(user)}\n`, { mode: 0o644 });
      changed = true;
    } else if (existsSync(file)) {
      rmSync(file, { force: true });
      changed = true;
    }
  }
  if (changed) runner.run('systemctl', ['daemon-reload']);
}

export function exportJobEnv(user: AgentUser, env: Record<string, string>, runner: Runner = realRunner): void {
  const on = Object.keys(env).length > 0;
  writeHomeText(jobEnvFile(user), Object.entries(env).map(([k, v]) => `${k}=${v}\n`).join(''), 0o644);
  setCronEnv(user, env, runner);
  setTimerEnv(user, on, runner);
  log.info({ on, keys: Object.keys(env).length }, "vault: the agent's scheduled jobs use the vault settings");
}
