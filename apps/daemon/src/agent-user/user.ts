import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { runningAsMetro } from '../metro-user/privilege.js';

export const AGENT_NAME = 'agent';
const AGENT_PATH = ['.local/bin', '/usr/local/sbin', '/usr/local/bin', '/usr/sbin', '/usr/bin', '/sbin', '/bin'];

export interface AgentUser {
  name: string;
  uid: number;
  gid: number;
  home: string;
}

export interface UserHost {
  metro: boolean;
  lookup: (name: string) => AgentUser | null;
}

export function lookupUser(name: string): AgentUser | null {
  const run = spawnSync('getent', ['passwd', name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  if (run.error !== undefined || run.status !== 0) return null;
  const [, , uid = '', gid = '', , home = ''] = run.stdout.trim().split(':');
  const u = Number(uid);
  const g = Number(gid);
  return Number.isInteger(u) && u > 0 && Number.isInteger(g) && home.startsWith('/') ? { name, uid: u, gid: g, home } : null;
}

const realHost = (): UserHost => ({ metro: runningAsMetro(), lookup: lookupUser });

export const agentUserExpected = (host: UserHost = realHost()): boolean => host.metro;

let cached: AgentUser | null = null;

export function agentUser(host: UserHost = realHost()): AgentUser | null {
  if (!agentUserExpected(host)) return null;
  cached ??= host.lookup(AGENT_NAME);
  return cached;
}

export function forgetAgentUser(): void {
  cached = null;
}

let extraEnv: Record<string, string> = {};

export function setAgentExtraEnv(env: Record<string, string>): void {
  extraEnv = { ...env };
}

export const agentExtraEnv = (): Record<string, string> => ({ ...extraEnv });

export function agentEnv(user: AgentUser, extra: Record<string, string> = {}): Record<string, string> {
  return {
    HOME: user.home,
    USER: user.name,
    LOGNAME: user.name,
    SHELL: '/bin/bash',
    LANG: process.env.LANG ?? 'C.UTF-8',
    TERM: process.env.TERM ?? 'xterm-256color',
    PATH: AGENT_PATH.map((p) => (p.startsWith('/') ? p : join(user.home, p))).join(':'),
    ...extraEnv,
    ...extra,
  };
}

export function asUser(user: AgentUser | null, file: string, args: readonly string[], extra: Record<string, string> = {}): [string, string[]] {
  if (user === null) return [file, [...args]];
  const env = Object.entries(agentEnv(user, extra)).map(([k, v]) => `${k}=${v}`);
  return ['sudo', ['-n', '-u', user.name, '--', 'env', '-i', ...env, file, ...args]];
}

export const asAgent = (file: string, args: readonly string[], extra: Record<string, string> = {}): [string, string[]] =>
  asUser(agentUser(), file, args, extra);

export const agentCommand = (command: readonly string[], extra: Record<string, string> = {}): string[] => {
  const [file = '', ...args] = command;
  const [bin, argv] = asAgent(file, args, extra);
  return [bin, ...argv];
};

export function claudeBin(user = agentUser()): string {
  return user === null ? 'claude' : join(user.home, '.local', 'bin', 'claude');
}

export const claudeHome = (user = agentUser()): string | null => (user === null ? null : user.home);

export const agentMarketplaceDir = (user: AgentUser): string => join(user.home, '.metro', 'marketplace');
export const agentViewDir = (user: AgentUser): string => join(user.home, '.metro', 'agents');
