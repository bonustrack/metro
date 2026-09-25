import { existsSync } from 'node:fs';
import { totalmem } from 'node:os';
import { helperArgv, runningAsMetro } from '../metro-user/privilege.js';

const GIB = 1024 ** 3;
const RESERVE = 1.5 * GIB;
const FLOOR = GIB;

export interface ScopeHost {
  metro: boolean;
  systemd: boolean;
  total: number;
}

const realHost = (): ScopeHost => ({
  metro: runningAsMetro(),
  systemd: existsSync('/run/systemd/system'),
  total: totalmem(),
});

export function sessionMemoryLimit(total: number): number {
  const kept = Math.min(Math.floor(total * 0.8), total - RESERVE);
  return Math.max(FLOOR, Math.floor(kept / (1024 * 1024)) * 1024 * 1024);
}

export function inSessionScope(command: [string, string[]], host: ScopeHost = realHost()): [string, string[]] {
  const [file, args] = command;
  const asAgent = file === 'sudo' && args[0] === '-n' && args[1] === '-u' && args[3] === '--';
  if (!host.metro || !host.systemd || !asAgent) return command;
  const limit = sessionMemoryLimit(host.total);
  return helperArgv(['as-agent-scope', String(limit), String(Math.floor(limit * 0.9)), ...args.slice(4)]);
}
