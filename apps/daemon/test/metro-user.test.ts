import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { helperScript, imdsUnitText, sudoersText } from '../src/metro-user/helper-script.ts';
import { blockImds } from '../src/metro-user/imds.ts';
import { installImdsGuard, installRootHelper } from '../src/metro-user/install.ts';
import { runningAsMetro, runningAsRoot } from '../src/metro-user/privilege.ts';

const hasVisudo = spawnSync('sh', ['-c', 'command -v visudo'], { stdio: 'ignore' }).status === 0;

describe('Metro as its own user', () => {
  test('metro may act as the agent, and as root only through the helper', () => {
    const rules = sudoersText('agent');
    expect(rules).toContain('metro ALL=(agent) NOPASSWD: ALL');
    expect(rules).toContain('metro ALL=(root) NOPASSWD: /usr/local/lib/metro/root-helper *');
    expect(rules.split('\n').filter((l) => l.includes('(root)'))).toHaveLength(1);
  });

  test('the helper only knows its own actions and refuses privileged service lines', () => {
    const helper = helperScript();
    expect(helper).toContain('*) die "unknown action: $action"');
    expect(helper).toContain('ExecStart=[+!@]*) die "privileged ExecStart refused"');
    expect(helper).toContain('*) die "line not allowed: $line"');
    expect(helper).toContain('case "$1" in metro*) die "not a metro unit";; esac');
    expect(helper).not.toContain('eval');
  });

  test.skipIf(!hasVisudo)('the install writes the helper and the checked sudo rules from the one source', () => {
    const dir = mkdtempSync(join(tmpdir(), 'metro-helper-'));
    const paths = { helper: join(dir, 'lib', 'root-helper'), sudoers: join(dir, 'sudoers') };
    installRootHelper(paths);
    expect(readFileSync(paths.helper, 'utf8')).toBe(helperScript());
    expect(statSync(paths.helper).mode & 0o777).toBe(0o755);
    expect(readFileSync(paths.sudoers, 'utf8')).toBe(sudoersText('agent'));
    expect(statSync(paths.sudoers).mode & 0o777).toBe(0o440);
    expect(existsSync(join(dir, 'lib'))).toBe(true);
  });

  test('root and metro are told apart by platform and user', () => {
    expect(runningAsRoot({ platform: 'linux', uid: 0, user: 'root' })).toBe(true);
    expect(runningAsRoot({ platform: 'darwin', uid: 0, user: 'root' })).toBe(false);
    expect(runningAsMetro({ platform: 'linux', uid: 994, user: 'metro' })).toBe(true);
    expect(runningAsMetro({ platform: 'linux', uid: 1000, user: 'less' })).toBe(false);
    expect(runningAsMetro({ platform: 'darwin', uid: 994, user: 'metro' })).toBe(false);
  });
});

const STUBS = (log: string, ip6: 'ok' | 'off', present: boolean): string =>
  [
    `id() { [ "$1 $2" = "-u metro" ] && echo 997 || return 1; }`,
    `rec() { printf '%s\\n' "$*" >> '${log}'; }`,
    `iptables() { rec iptables "$@"; case "$*" in *" -C "*) ${present ? 'return 0' : 'return 1'};; esac; }`,
    `ip6tables() { case "$*" in *" -L "*) ${ip6 === 'ok' ? 'return 0' : 'return 1'};; esac; rec ip6tables "$@"; case "$*" in *" -C "*) ${present ? 'return 0' : 'return 1'};; esac; }`,
  ].join('\n');

function runHelper(action: string, ip6: 'ok' | 'off' = 'ok', present = false): { status: number | null; calls: string[]; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), 'metro-imds-'));
  const log = join(dir, 'calls');
  writeFileSync(log, '');
  const run = spawnSync('sh', ['-c', `${STUBS(log, ip6, present)}\n${helperScript()}`, 'root-helper', action], { encoding: 'utf8' });
  return { status: run.status, calls: readFileSync(log, 'utf8').trim().split('\n').filter(Boolean), stderr: run.stderr };
}

describe('only root and metro reach the instance metadata service', () => {
  const chain = (t: string): string[] => [
    `${t} -w -L OUTPUT -n`,
    `${t} -w -N METRO_IMDS`,
    `${t} -w -F METRO_IMDS`,
    `${t} -w -A METRO_IMDS -m owner --uid-owner 0 -j RETURN`,
    `${t} -w -A METRO_IMDS -m owner --uid-owner 997 -j RETURN`,
    `${t} -w -A METRO_IMDS -p tcp -j REJECT --reject-with tcp-reset`,
    `${t} -w -A METRO_IMDS -j REJECT`,
  ];

  test('imds-block sends every other user\'s traffic to the metadata addresses into a rejecting chain, v4 and v6', () => {
    const run = runHelper('imds-block');
    expect(run.status).toBe(0);
    expect(run.calls).toEqual([
      ...chain('iptables'),
      'iptables -w -C OUTPUT -d 169.254.169.254 -j METRO_IMDS',
      'iptables -w -I OUTPUT -d 169.254.169.254 -j METRO_IMDS',
      ...chain('ip6tables').slice(1),
      'ip6tables -w -C OUTPUT -d fd00:ec2::254 -j METRO_IMDS',
      'ip6tables -w -I OUTPUT -d fd00:ec2::254 -j METRO_IMDS',
    ]);
  });

  test('a second run adds no second jump, and a box without IPv6 still gets the IPv4 guard', () => {
    const again = runHelper('imds-block', 'ok', true);
    expect(again.status).toBe(0);
    expect(again.calls.filter((c) => c.includes(' -I OUTPUT'))).toEqual([]);
    const v4 = runHelper('imds-block', 'off');
    expect(v4.status).toBe(0);
    expect(v4.calls.some((c) => c.startsWith('ip6tables'))).toBe(false);
    expect(v4.calls).toContain('iptables -w -I OUTPUT -d 169.254.169.254 -j METRO_IMDS');
  });

  test('the helper says version 2, so a box can tell it has the guard', () => {
    const run = spawnSync('sh', ['-c', helperScript(), 'root-helper', 'version'], { encoding: 'utf8' });
    expect(run.stdout.trim()).toBe('2');
  });

  test('a boot unit applies it before the network comes up, so a reboot never leaves a gap', () => {
    const unit = imdsUnitText();
    expect(unit).toContain('ExecStart=/usr/local/lib/metro/root-helper imds-block');
    expect(unit).toContain('Before=network-pre.target');
    expect(unit).toContain('Type=oneshot');
    expect(unit).toContain('WantedBy=multi-user.target');
    const dir = mkdtempSync(join(tmpdir(), 'metro-imds-unit-'));
    const ran: string[] = [];
    installImdsGuard(join(dir, 'metro-imds.service'), (file, args) => {
      ran.push([file, ...args].join(' '));
    });
    expect(readFileSync(join(dir, 'metro-imds.service'), 'utf8')).toBe(unit);
    expect(ran).toEqual(['systemctl daemon-reload', 'systemctl enable metro-imds.service', 'systemctl restart metro-imds.service']);
  });

  test('the daemon applies it at every start, and a box whose helper predates it only logs how to fix it', () => {
    const asked: string[][] = [];
    expect(blockImds((args) => {
      asked.push(args);
      return { status: 0, stdout: '', stderr: '' };
    })).toBe(true);
    expect(asked).toEqual([['imds-block']]);
    expect(blockImds(() => ({ status: 2, stdout: '', stderr: 'root-helper: unknown action: imds-block' }))).toBe(false);
  });
});
