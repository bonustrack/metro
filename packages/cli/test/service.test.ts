import { describe, expect, test } from 'bun:test';
import { service, servicePlan, type ServiceDeps, type ServiceHost } from '../src/service.ts';

const linuxRoot: ServiceHost = {
  platform: 'linux',
  uid: 0,
  user: 'root',
  home: '/root',
  node: '/usr/bin/node',
  cli: '/usr/local/bin/metro',
  env: { PATH: '/usr/bin:/root/.bun/bin', HOME: '/root', METRO_WEBHOOK_PORT: '8421', SHELL: '/bin/bash', PWD: '/x' },
};
const linuxUser: ServiceHost = { ...linuxRoot, uid: 1000, user: 'less', home: '/home/less' };
const mac: ServiceHost = {
  platform: 'darwin',
  uid: 501,
  user: 'less',
  home: '/Users/less',
  node: '/opt/homebrew/bin/node',
  cli: '/Users/less/a & b/metro',
  env: { PATH: '/opt/homebrew/bin', HOME: '/Users/less' },
};

interface Fake {
  deps: ServiceDeps;
  ran: string[];
  files: Map<string, string>;
  lines: string[];
}

function fake(host: ServiceHost, over: Partial<ServiceDeps> = {}): Fake {
  const ran: string[] = [];
  const files = new Map<string, string>();
  const lines: string[] = [];
  return {
    deps: {
      host,
      run: (command) => {
        ran.push(command.args.join(' '));
        return { status: 0, output: '' };
      },
      running: () => null,
      preflight: () => undefined,
      mkdir: (dir) => {
        ran.push(`mkdir ${dir}`);
      },
      write: (file, content) => {
        files.set(file, content);
      },
      remove: (file) => {
        files.delete(file);
      },
      exists: (file) => files.has(file),
      out: (line) => {
        lines.push(line);
      },
      ...over,
    },
    ran,
    files,
    lines,
  };
}

describe('what metro service writes', () => {
  test('root on Linux gets a system unit that restarts always and carries only PATH, HOME and METRO_*', () => {
    const plan = servicePlan(linuxRoot, ['--port', '8421']);
    expect(plan.kind).toBe('systemd');
    expect(plan.file).toBe('/etc/systemd/system/metro.service');
    expect(plan.content).toContain('ExecStart=/usr/bin/node /usr/local/bin/metro serve --port 8421\n');
    expect(plan.content).toContain('Restart=always\nRestartSec=2\n');
    expect(plan.content).toContain('After=network-online.target tailscaled.service');
    expect(plan.content).toContain('Environment=HOME=/root\nEnvironment=METRO_WEBHOOK_PORT=8421\nEnvironment=PATH=/usr/bin:/root/.bun/bin\n');
    expect(plan.content).not.toContain('SHELL');
    expect(plan.content).not.toContain('PWD');
    expect(plan.content).toContain('WantedBy=multi-user.target');
    expect(plan.install.map((c) => c.args.join(' '))).toEqual(['systemctl daemon-reload', 'systemctl enable --now metro']);
    expect(plan.uninstall.map((c) => c.args.join(' '))).toEqual(['systemctl disable --now metro']);
    expect(plan.status.args.join(' ')).toBe('systemctl is-active metro');
    expect(plan.hints).toEqual(['Logs:  journalctl -u metro -f']);
  });

  test('another user gets a user unit, with the linger hint', () => {
    const plan = servicePlan(linuxUser, []);
    expect(plan.file).toBe('/home/less/.config/systemd/user/metro.service');
    expect(plan.content).toContain('WantedBy=default.target');
    expect(plan.install.map((c) => c.args.join(' '))).toEqual(['systemctl --user daemon-reload', 'systemctl --user enable --now metro']);
    expect(plan.hints[1]).toContain('loginctl enable-linger less');
  });

  test('macOS gets a launch agent, XML-escaped, with the log dir created first', () => {
    const plan = servicePlan(mac, []);
    expect(plan.kind).toBe('launchd');
    expect(plan.file).toBe('/Users/less/Library/LaunchAgents/box.metro.serve.plist');
    expect(plan.content).toContain('<key>Label</key><string>box.metro.serve</string>');
    expect(plan.content).toContain('<string>/Users/less/a &amp; b/metro</string>');
    expect(plan.content).toContain('<key>KeepAlive</key><true/>');
    expect(plan.content).toContain('<key>StandardOutPath</key><string>/Users/less/.cache/metro/serve/service.log</string>');
    expect(plan.dirs).toEqual(['/Users/less/.cache/metro/serve']);
    expect(plan.install).toEqual([
      { args: ['launchctl', 'bootout', 'gui/501/box.metro.serve'], mayFail: true },
      { args: ['launchctl', 'bootstrap', 'gui/501', '/Users/less/Library/LaunchAgents/box.metro.serve.plist'] },
    ]);
    expect(plan.status.args.join(' ')).toBe('launchctl print gui/501/box.metro.serve');
  });

  test('a path with a space or a percent sign survives the unit file', () => {
    const plan = servicePlan({ ...linuxRoot, cli: '/opt/my metro/cli.js', env: { PATH: '/bin:/opt/100%' } }, []);
    expect(plan.content).toContain('ExecStart=/usr/bin/node "/opt/my metro/cli.js" serve\n');
    expect(plan.content).toContain('Environment="PATH=/bin:/opt/100%%"\n');
  });

  test('anything but Linux and macOS is refused by name', () => {
    expect(() => servicePlan({ ...linuxRoot, platform: 'win32' }, [])).toThrow(/not win32/);
  });
});

describe('metro service install, uninstall and status', () => {
  test('install checks the machine, writes the unit and enables it', async () => {
    const owners: (string | null)[] = [];
    const f = fake(linuxRoot, {
      preflight: (owner) => {
        owners.push(owner);
      },
    });
    expect(await service(['install', '--owner', '0xEF8305E140ac520225DAf050e2f71d5fBCC543e7'], f.deps)).toBe(0);
    expect(owners).toEqual(['0xef8305e140ac520225daf050e2f71d5fbcc543e7']);
    expect(f.files.get('/etc/systemd/system/metro.service')).toContain(
      'serve --owner 0xEF8305E140ac520225DAf050e2f71d5fBCC543e7\n',
    );
    expect(f.ran).toEqual(['systemctl daemon-reload', 'systemctl enable --now metro']);
    expect(f.lines[0]).toContain('Installed /etc/systemd/system/metro.service');
  });

  test('install refuses while a metro serve is running, and refuses a bad flag before touching anything', () => {
    const running = fake(linuxRoot, { running: () => 4242 });
    expect(() => service(['install'], running.deps)).toThrow(/pid 4242.*metro stop/);
    expect(running.files.size).toBe(0);
    const bad = fake(linuxRoot);
    expect(() => service(['install', '--detach'], bad.deps)).toThrow(/unknown argument '--detach'/);
    expect(bad.ran).toEqual([]);
  });

  test('uninstall stops it, removes the unit and reloads; nothing installed is a plain 1', async () => {
    const f = fake(mac);
    expect(await service(['uninstall'], f.deps)).toBe(1);
    expect(f.lines).toEqual(['metro is not installed as a service on this machine']);
    f.files.set('/Users/less/Library/LaunchAgents/box.metro.serve.plist', 'x');
    expect(await service(['uninstall'], f.deps)).toBe(0);
    expect(f.ran).toEqual(['launchctl bootout gui/501/box.metro.serve']);
    expect(f.files.size).toBe(0);
  });

  test('status reports installed and running as exit codes', async () => {
    const f = fake(linuxUser);
    expect(await service(['status'], f.deps)).toBe(1);
    expect(f.lines[0]).toContain('not installed');
    f.files.set('/home/less/.config/systemd/user/metro.service', 'x');
    expect(await service(['status'], f.deps)).toBe(0);
    expect(f.lines[1]).toContain('running as a systemd service');
    const down = fake(linuxUser, { run: () => ({ status: 3, output: 'inactive' }) });
    down.files.set('/home/less/.config/systemd/user/metro.service', 'x');
    expect(await service(['status'], down.deps)).toBe(1);
    expect(down.lines[0]).toContain('not running');
  });

  test('anything else prints the usage', () => {
    for (const argv of [[], ['dance'], ['status', 'now'], ['uninstall', '--force']])
      expect(() => service(argv, fake(linuxRoot).deps)).toThrow(/usage: metro service/);
  });
});
