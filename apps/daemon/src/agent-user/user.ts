import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
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

function lookupUser(name: string): AgentUser | null {
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

export const agentPath = (user: AgentUser): string => AGENT_PATH.map((p) => (p.startsWith('/') ? p : join(user.home, p))).join(':');

function agentEnv(user: AgentUser, extra: Record<string, string> = {}): Record<string, string> {
  return {
    HOME: user.home,
    USER: user.name,
    LOGNAME: user.name,
    SHELL: '/bin/bash',
    LANG: process.env.LANG ?? 'C.UTF-8',
    TERM: process.env.TERM ?? 'xterm-256color',
    PATH: agentPath(user),
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

const SDK_PACKAGE = '@anthropic-ai/claude-agent-sdk';

export const CLAUDE_ENV: Readonly<Record<string, string>> = { DISABLE_AUTOUPDATER: '1' };

let musl: boolean | null = null;

function muslFirst(): boolean {
  if (process.platform !== 'linux') return false;
  if (musl === null) {
    const report = process.report.getReport() as { header?: { glibcVersionRuntime?: string } };
    musl = report.header?.glibcVersionRuntime === undefined;
  }
  return musl;
}

export function claudeBin(user = agentUser()): string {
  const name = `${SDK_PACKAGE}-${process.platform}-${process.arch}`;
  const packages = muslFirst() ? [`${name}-musl`, name] : [name, `${name}-musl`];
  const [first = '', other = ''] = packages.map((pkg) => join(user?.home ?? homedir(), '.metro', 'sdk-runner', 'node_modules', pkg, 'claude'));
  return existsSync(first) || !existsSync(other) ? first : other;
}

export const claudeHome = (user = agentUser()): string | null => (user === null ? null : user.home);

export const agentViewDir = (user: AgentUser): string => join(user.home, '.metro', 'agents');
