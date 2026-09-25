import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mustHelper, rootHelper, runningAsMetro } from '../metro-user/privilege.js';
import { agentUser, asUser } from './user.js';

const UNIT_DIR = '/etc/systemd/system';

export function writeDropIn(service: string, name: string, text: string): void {
  if (runningAsMetro()) {
    mustHelper(['dropin-write', service, name], text);
    return;
  }
  mkdirSync(join(UNIT_DIR, `${service}.d`), { recursive: true });
  writeFileSync(join(UNIT_DIR, `${service}.d`, name), text, { mode: 0o644 });
}

export function removeDropIn(service: string, name: string): boolean {
  const file = join(UNIT_DIR, `${service}.d`, name);
  if (!existsSync(file)) return false;
  if (runningAsMetro()) mustHelper(['dropin-remove', service, name]);
  else rmSync(file, { force: true });
  return true;
}

const lineHash = (line: string): string => createHash('sha256').update(line.trim()).digest('hex').slice(0, 16);

function asAgentRun(args: string[], input?: string): { status: number | null; stdout: string } {
  const [file, argv] = asUser(agentUser(), 'crontab', args);
  const run = spawnSync(file, argv, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'ignore'], timeout: 20_000 });
  return { status: run.error === undefined ? run.status : null, stdout: run.stdout ?? '' };
}

function rootCrontabWrite(input: string): { status: number | null; stdout: string } {
  const wanted = new Set(input.split('\n').filter((l) => l.trim() !== '').map(lineHash));
  const current = rootHelper(['root-crontab']).stdout.split('\n').filter((l) => l.trim() !== '');
  for (const line of current) if (!wanted.has(lineHash(line))) mustHelper(['root-crontab-drop', lineHash(line)]);
  return { status: 0, stdout: '' };
}

function crontab(args: string[], input?: string): { status: number | null; stdout: string } {
  const at = args.indexOf('-u');
  const who = at >= 0 ? args[at + 1] : undefined;
  const rest = args.filter((_, i) => i !== at && i !== at + 1);
  if (who === 'root') return rest[0] === '-l' ? { status: 0, stdout: rootHelper(['root-crontab']).stdout } : rootCrontabWrite(input ?? '');
  return asAgentRun(rest, input);
}

function systemctl(args: string[]): { status: number | null; stdout: string } | null {
  if (args[0] === 'daemon-reload') return { status: rootHelper(['daemon-reload']).status, stdout: '' };
  if (args[0] === 'start') return { status: rootHelper(['start-job', args[args.length - 1] ?? '']).status, stdout: '' };
  return null;
}

export function metroRun(file: string, args: string[], input?: string): { status: number | null; stdout: string } | null {
  if (!runningAsMetro()) return null;
  if (file === 'crontab') return crontab(args, input);
  if (file === 'systemctl') return systemctl(args);
  return null;
}
