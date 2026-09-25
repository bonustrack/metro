import { spawnSync } from 'node:child_process';
import { mustHelper, runningAsMetro } from '../metro-user/privilege.js';

const CHAIN = 'METRO_AGENT';
const TOOLS = ['iptables', 'ip6tables'] as const;

export interface FirewallRunner {
  run: (file: string, args: string[]) => number | null;
}

const realRunner: FirewallRunner = { run: (file, args) => spawnSync(file, ['-w', ...args], { stdio: 'ignore' }).status };

export const chainRules = (): string[][] => [
  ['-A', CHAIN, '-o', 'lo', '-j', 'ACCEPT'],
  ['-A', CHAIN, '-m', 'conntrack', '--ctstate', 'ESTABLISHED,RELATED', '-j', 'ACCEPT'],
  ['-A', CHAIN, '-p', 'udp', '--dport', '53', '-j', 'ACCEPT'],
  ['-A', CHAIN, '-p', 'tcp', '--dport', '53', '-j', 'ACCEPT'],
  ['-A', CHAIN, '-p', 'tcp', '-j', 'REJECT', '--reject-with', 'tcp-reset'],
  ['-A', CHAIN, '-j', 'REJECT'],
];

const jump = (uid: number): string[] => ['OUTPUT', '-m', 'owner', '--uid-owner', String(uid), '-j', CHAIN];

export function applyFirewall(uid: number, runner: FirewallRunner = realRunner): void {
  if (runner === realRunner && runningAsMetro()) {
    mustHelper(['firewall-on']);
    return;
  }
  for (const tool of TOOLS) {
    runner.run(tool, ['-N', CHAIN]);
    if (runner.run(tool, ['-F', CHAIN]) !== 0) throw new Error(`${tool} refused to prepare the ${CHAIN} chain`);
    for (const rule of chainRules()) if (runner.run(tool, rule) !== 0) throw new Error(`${tool} refused a rule: ${rule.join(' ')}`);
    if (runner.run(tool, ['-C', ...jump(uid)]) !== 0 && runner.run(tool, ['-I', ...jump(uid)]) !== 0)
      throw new Error(`${tool} refused to send the agent's traffic to ${CHAIN}`);
  }
}

export function removeFirewall(uid: number, runner: FirewallRunner = realRunner): void {
  if (runner === realRunner && runningAsMetro()) {
    mustHelper(['firewall-off']);
    return;
  }
  for (const tool of TOOLS) {
    for (let i = 0; i < 10 && runner.run(tool, ['-C', ...jump(uid)]) === 0; i += 1) runner.run(tool, ['-D', ...jump(uid)]);
    runner.run(tool, ['-F', CHAIN]);
    runner.run(tool, ['-X', CHAIN]);
  }
}
