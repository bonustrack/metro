import { join } from 'node:path';
import { log } from '@metro-labs/core/log';
import { editCrontab, withBlock } from './crontab.js';
import { writeHomeText } from './home-fs.js';
import { listSchedules, realRunner, showProps, type Runner } from './schedules.js';
import type { AgentUser } from './user.js';
import { removeDropIn, writeDropIn } from './unit-files.js';

const DROP_IN = '11-metro-vault.conf';
const BEGIN = '# metro vault: begin';
const END = '# metro vault: end';

const jobEnvFile = (user: AgentUser): string => join(user.home, '.metro', 'vault.env');

export function withCronEnv(lines: string[], env: Record<string, string>): string[] {
  return withBlock(lines, BEGIN, END, Object.entries(env).map(([k, v]) => `${k}=${v}`), 'top');
}

function setTimerEnv(user: AgentUser, on: boolean, runner: Runner): void {
  let changed = false;
  for (const job of listSchedules(user, runner)) {
    if (job.kind !== 'timer' || job.runsAs !== user.name) continue;
    const unit = job.id.slice('timer:'.length);
    const service = showProps(runner, unit, ['Unit']).Unit ?? unit.replace(/\.timer$/, '.service');
    if (on) {
      writeDropIn(service, DROP_IN, `[Service]\nEnvironmentFile=-${jobEnvFile(user)}\n`);
      changed = true;
    } else if (removeDropIn(service, DROP_IN)) changed = true;
  }
  if (changed) runner.run('systemctl', ['daemon-reload']);
}

export function exportJobEnv(user: AgentUser, env: Record<string, string>, runner: Runner = realRunner): void {
  const on = Object.keys(env).length > 0;
  writeHomeText(jobEnvFile(user), Object.entries(env).map(([k, v]) => `${k}=${v}\n`).join(''), 0o644);
  editCrontab(user, runner, (lines) => withCronEnv(lines, env));
  setTimerEnv(user, on, runner);
  log.info({ on, keys: Object.keys(env).length }, "vault: the agent's scheduled jobs use the vault settings");
}
