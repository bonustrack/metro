import { spawnSync } from 'node:child_process';
import { rootHelper } from '../metro-user/privilege.js';
import { agentUser, asUser } from './user.js';

export interface RunResult {
  status: number | null;
  stdout: string;
  stderr?: string;
}

function agentCrontab(args: string[], input?: string): RunResult {
  const at = args.indexOf('-u');
  const rest = at < 0 ? args : args.filter((_, i) => i !== at && i !== at + 1);
  const [file, argv] = asUser(agentUser(), 'crontab', rest);
  const run = spawnSync(file, argv, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'], timeout: 20_000 });
  return { status: run.error === undefined ? run.status : null, stdout: run.stdout ?? '', stderr: run.stderr ?? '' };
}

function systemctl(args: string[]): { status: number | null; stdout: string } | null {
  if (args[0] === 'daemon-reload') return { status: rootHelper(['daemon-reload']).status, stdout: '' };
  if (args[0] === 'start') return { status: rootHelper(['start-job', args[args.length - 1] ?? '']).status, stdout: '' };
  return null;
}

export function helperRun(file: string, args: string[], input?: string): RunResult | null {
  if (file === 'crontab') return agentCrontab(args, input);
  if (file === 'systemctl') return systemctl(args);
  return null;
}
