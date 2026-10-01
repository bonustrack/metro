import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { helperScript, upgradeUnitText } from '../src/metro-user/helper-script.ts';
import { installUpgradeUnit, nodeArg } from '../src/metro-user/install.ts';
import { followRelease } from '../src/metro-user/root-follow.ts';

const VAULT = '[Service]\nEnvironmentFile=-/home/agent/.metro/vault.env\n';
const AGENT_JOB: Record<string, string> = {
  FragmentPath: '/etc/systemd/system/backup.service',
  TriggeredBy: 'backup.timer',
  User: 'agent',
  PermissionsStartOnly: 'no',
  ExecStartEx: '{ path=/home/agent/backup.sh ; argv[]=/home/agent/backup.sh ; flags= ; start_time=[n/a] }',
};

const STUBS = (log: string, props: Record<string, string>): string =>
  [
    `rec() { printf '%s\\n' "$*" >> '${log}'; }`,
    `getent() { [ "$1 $2" = "passwd agent" ] && echo 'agent:x:1001:1001::/home/agent:/bin/bash'; }`,
    'mkdir() { rec mkdir "$@"; }',
    'install() { rec install "$@"; }',
    'systemctl() {',
    '  if [ "$1" != show ]; then rec systemctl "$@"; return 0; fi',
    '  shift 2',
    '  while [ "$#" -gt 0 ]; do',
    '    if [ "$1" = -p ]; then case "$2" in',
    ...Object.entries(props).map(([k, v]) => `      ${k}) printf '%s\\n' '${v}' ;;`),
    '      *) echo ;;',
    '    esac; shift 2; else shift; fi',
    '  done',
    '}',
  ].join('\n');

function helper(args: string[], props: Record<string, string> = AGENT_JOB, input = ''): { status: number | null; calls: string[]; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), 'metro-helper-'));
  const log = join(dir, 'calls');
  writeFileSync(log, '');
  const run = spawnSync('sh', ['-c', `${STUBS(log, props)}\n${helperScript()}`, 'root-helper', ...args], { encoding: 'utf8', input });
  return { status: run.status, calls: readFileSync(log, 'utf8').trim().split('\n').filter(Boolean), stderr: run.stderr };
}

describe('metro asks root to follow an update, and only with a version number', () => {
  test('a version starts the root upgrade unit for exactly that version, without waiting for it', () => {
    for (const version of ['0.1.0-beta.247', '1.2.3']) {
      const run = helper(['upgrade', version]);
      expect(run.status).toBe(0);
      expect(run.calls).toEqual([`systemctl start --no-block metro-root-upgrade@${version}.service`]);
    }
  });

  test('anything that is not a plain version is refused before systemd hears of it', () => {
    for (const bad of ['', '1.2', '../../x', '-Hevil.service', '0.1.0-beta.1 x', '0.1.0\nfoo', '0.1.0-beta.1.service/x', '1.2.3-', '1.2.3-a_b']) {
      const run = helper(['upgrade', bad]);
      expect(run.status).toBe(2);
      expect(run.calls).toEqual([]);
    }
    expect(helper(['upgrade', '1.2.3', '1.2.4']).status).toBe(2);
    expect(helper(['upgrade']).status).toBe(2);
  });
});

describe('the drop-in writer cannot give metro root', () => {
  test('the vault environment file goes on a timer job that runs as the agent', () => {
    const run = helper(['dropin-write', 'backup.service', '11-metro-vault.conf'], AGENT_JOB, VAULT);
    expect(run.status).toBe(0);
    expect(run.calls[0]).toBe('mkdir -p /etc/systemd/system/backup.service.d');
    expect(run.calls[1]).toMatch(/^install -m 644 \S+ \/etc\/systemd\/system\/backup\.service\.d\/11-metro-vault\.conf$/);
  });

  test('any other content, or the old user drop-in, is refused', () => {
    const extra = [
      `${VAULT}ExecStart=\nExecStart=/bin/sh -c id\n`,
      '[Service]\nEnvironment=LD_PRELOAD=/var/lib/metro/x.so\n',
      '[Service]\nEnvironmentFile=-/var/lib/metro/.metro/x.env\n',
      `${VAULT.trimEnd()} \\\n`,
    ];
    for (const text of extra) {
      const run = helper(['dropin-write', 'backup.service', '11-metro-vault.conf'], AGENT_JOB, text);
      expect(run.status).toBe(2);
      expect(run.calls).toEqual([]);
    }
    const user = helper(['dropin-write', 'backup.service', '10-metro-agent.conf'], AGENT_JOB, '[Service]\nUser=agent\n');
    expect(user.status).toBe(2);
    expect(helper(['dropin-remove', 'backup.service', '10-metro-agent.conf']).status).toBe(2);
    expect(helper(['dropin-remove', 'backup.service', '11-metro-vault.conf']).status).toBe(0);
  });

  test('a job that runs as root, or runs any command with root rights, gets nothing', () => {
    const cases: Record<string, string>[] = [
      { ...AGENT_JOB, User: '' },
      { ...AGENT_JOB, User: 'root' },
      { ...AGENT_JOB, PermissionsStartOnly: 'yes' },
      { ...AGENT_JOB, ExecStartPreEx: '{ path=/usr/bin/install ; argv[]=/usr/bin/install -d /x ; flags=privileged ; start_time=[n/a] }' },
      { ...AGENT_JOB, ExecStopPostEx: '{ path=/bin/true ; argv[]=/bin/true ; flags=ignore-failure|no-setuid ; start_time=[n/a] }' },
      { ...AGENT_JOB, ExecStartEx: '' },
    ];
    for (const props of cases) {
      const run = helper(['dropin-write', 'backup.service', '11-metro-vault.conf'], props, VAULT);
      expect(run.status).toBe(2);
      expect(run.calls).toEqual([]);
    }
  });

  test('a service name that could be read as a systemctl flag is refused', () => {
    for (const name of ['-Hevil.service', '.hidden.service', 'a b.service', 'x.service\n-Hy.service']) {
      const run = helper(['dropin-write', name, '11-metro-vault.conf'], AGENT_JOB, VAULT);
      expect(run.status).toBe(2);
      expect(run.stderr).toContain('bad service name');
    }
  });
});

describe('the root upgrade unit and the daemon side', () => {
  test('the unit runs the root copy with root\'s own node, one upgrade at a time', () => {
    const unit = upgradeUnitText('/usr/bin/node');
    expect(unit).toContain('Type=oneshot');
    expect(unit).toContain(
      'ExecStart=/usr/bin/flock /usr/local/lib/metro /usr/bin/node /usr/local/lib/metro/release/dist/cli.js service root-upgrade %i\n',
    );
    expect(unit).toContain('After=network-online.target');
    expect(unit).not.toContain('/var/lib/metro');
    expect(unit).not.toContain('[Install]');
  });

  test('install writes it for the node it is given, and refuses a node path a unit could misread', () => {
    const dir = mkdtempSync(join(tmpdir(), 'metro-upgrade-unit-'));
    const ran: string[] = [];
    installUpgradeUnit('/usr/bin/node', join(dir, 'u.service'), (file, args) => {
      ran.push([file, ...args].join(' '));
    });
    expect(readFileSync(join(dir, 'u.service'), 'utf8')).toBe(upgradeUnitText('/usr/bin/node'));
    expect(ran).toEqual(['systemctl daemon-reload']);
    for (const node of ['node', '/opt/my node/bin/node', '/usr/bin/node%i', '/usr/bin/node\nExecStartPre=/x'])
      expect(() => {
        installUpgradeUnit(node, join(dir, 'v.service'), () => undefined);
      }).toThrow(/plain absolute path/);
    expect(nodeArg(['--node', '/usr/bin/node'])).toBe('/usr/bin/node');
    expect(() => nodeArg([])).toThrow(/usage/);
  });

  test('at every start the daemon asks root to follow its own version, and an older helper only logs the one root step', () => {
    const asked: string[][] = [];
    expect(
      followRelease((args) => {
        asked.push(args);
        return { status: 0, stdout: '', stderr: '' };
      }, '0.1.0-beta.247'),
    ).toBe(true);
    expect(asked).toEqual([['upgrade', '0.1.0-beta.247']]);
    expect(followRelease(() => ({ status: 2, stdout: '', stderr: 'root-helper: unknown action: upgrade' }), '0.1.0-beta.247')).toBe(false);
  });
});
