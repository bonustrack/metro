import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { mustHelper, rootHelper } from '../metro-user/privilege.js';
import { agentUser, asUser } from './user.js';

const UNIT_DIR = '/etc/systemd/system';

export function writeDropIn(service: string, name: string, text: string): void {
  mustHelper(['dropin-write', service, name], text);
}

export function removeDropIn(service: string, name: string): boolean {
  if (!existsSync(join(UNIT_DIR, `${service}.d`, name))) return false;
  mustHelper(['dropin-remove', service, name]);
  return true;
}

function agentCrontab(args: string[], input?: string): { status: number | null; stdout: string } {
  const at = args.indexOf('-u');
  const rest = at < 0 ? args : args.filter((_, i) => i !== at && i !== at + 1);
  const [file, argv] = asUser(agentUser(), 'crontab', rest);
  const run = spawnSync(file, argv, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'ignore'], timeout: 20_000 });
  return { status: run.error === undefined ? run.status : null, stdout: run.stdout ?? '' };
}

function systemctl(args: string[]): { status: number | null; stdout: string } | null {
  if (args[0] === 'daemon-reload') return { status: rootHelper(['daemon-reload']).status, stdout: '' };
  if (args[0] === 'start') return { status: rootHelper(['start-job', args[args.length - 1] ?? '']).status, stdout: '' };
  return null;
}

export function helperRun(file: string, args: string[], input?: string): { status: number | null; stdout: string } | null {
  if (file === 'crontab') return agentCrontab(args, input);
  if (file === 'systemctl') return systemctl(args);
  return null;
}
