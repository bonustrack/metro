import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { totalmem } from 'node:os';
import { dirname } from 'node:path';
import { errMsg, log } from '@metro-labs/core/log';
import { helperArgv, runningAsMetro } from '../metro-user/privilege.js';

const UNIT = '/etc/systemd/system/metro.service';
const DROP_IN = '/etc/systemd/system/metro.service.d/10-metro-memory.conf';
const DROP_IN_TEXT = '[Service]\nOOMPolicy=continue\n';
const GIB = 1024 ** 3;
const RESERVE = 1.5 * GIB;
const FLOOR = GIB;

export interface ScopeHost {
  platform: string;
  uid: number | undefined;
  systemd: boolean;
  total: number;
}

const realHost = (): ScopeHost => ({
  platform: process.platform,
  uid: process.getuid?.(),
  systemd: existsSync('/run/systemd/system'),
  total: totalmem(),
});

export function sessionMemoryLimit(total: number): number {
  const kept = Math.min(Math.floor(total * 0.8), total - RESERVE);
  return Math.max(FLOOR, Math.floor(kept / (1024 * 1024)) * 1024 * 1024);
}

const usesScopes = (host: ScopeHost): boolean => host.platform === 'linux' && host.uid === 0 && host.systemd;

function metroScope(command: [string, string[]], total: number): [string, string[]] {
  const [file, args] = command;
  const asAgent = file === 'sudo' && args[0] === '-n' && args[1] === '-u' && args[3] === '--';
  if (!asAgent) return command;
  const limit = sessionMemoryLimit(total);
  return helperArgv(['as-agent-scope', String(limit), String(Math.floor(limit * 0.9)), ...args.slice(4)]);
}

export function inSessionScope(command: [string, string[]], host: ScopeHost = realHost(), now = Date.now()): [string, string[]] {
  if (host.systemd && runningAsMetro()) return metroScope(command, host.total);
  if (!usesScopes(host)) return command;
  const limit = sessionMemoryLimit(host.total);
  const [file, args] = command;
  return [
    'systemd-run',
    [
      '--scope',
      '--quiet',
      '--collect',
      `--unit=metro-claude-${String(now)}`,
      '-p',
      `MemoryMax=${String(limit)}`,
      '-p',
      `MemoryHigh=${String(Math.floor(limit * 0.9))}`,
      '-p',
      'OOMPolicy=continue',
      '--',
      file,
      ...args,
    ],
  ];
}

export function ensureServiceOomPolicy(host: ScopeHost = realHost(), env: NodeJS.ProcessEnv = process.env): 'written' | 'present' | 'skipped' {
  if (!usesScopes(host) || (env.INVOCATION_ID ?? '') === '' || !existsSync(UNIT)) return 'skipped';
  try {
    if (existsSync(DROP_IN) && readFileSync(DROP_IN, 'utf8') === DROP_IN_TEXT) return 'present';
    mkdirSync(dirname(DROP_IN), { recursive: true });
    writeFileSync(DROP_IN, DROP_IN_TEXT, { mode: 0o644 });
    const reload = spawnSync('systemctl', ['daemon-reload'], { stdio: 'ignore' });
    log.info({ reloaded: reload.status === 0 }, 'claude-memory: the metro service no longer stops as a whole when the kernel kills one process for memory');
    return 'written';
  } catch (err) {
    log.warn({ err: errMsg(err) }, 'claude-memory: could not set the service memory policy');
    return 'skipped';
  }
}
