import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, platform, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { serveLockedBy } from './control.js';
import { findBun } from './runtime.js';
import { findTailscale, parseServeArgs, requireOwner } from './serve.js';

const USAGE = 'usage: metro service install [--port <n>] [--owner <address>] | uninstall | status';
const SERVICE = 'metro';
const LABEL = 'box.metro.serve';
const CARRIED = /^(METRO_.*|XDG_CACHE_HOME|PATH|HOME)$/;
const PLAIN_WORD = /^[A-Za-z0-9_/.:=+@,-]+$/;

export interface ServiceHost {
  platform: string;
  uid: number;
  user: string;
  home: string;
  node: string;
  cli: string;
  env: NodeJS.ProcessEnv;
}

export interface Command {
  args: string[];
  mayFail?: boolean;
}

export interface ServicePlan {
  kind: 'systemd' | 'launchd';
  file: string;
  content: string;
  dirs: string[];
  install: Command[];
  uninstall: Command[];
  reload: Command[];
  status: Command;
  hints: string[];
}

export interface ServiceDeps {
  host: ServiceHost;
  run: (command: Command) => { status: number; output: string };
  running: () => number | null;
  preflight: (owner: string | null) => void;
  mkdir: (dir: string) => void;
  write: (file: string, content: string) => void;
  remove: (file: string) => void;
  exists: (file: string) => boolean;
  out: (line: string) => void;
}

const carriedEnv = (env: NodeJS.ProcessEnv): [string, string][] =>
  Object.entries(env)
    .filter((entry): entry is [string, string] => CARRIED.test(entry[0]) && typeof entry[1] === 'string' && entry[1] !== '')
    .sort(([a], [b]) => a.localeCompare(b));

const cacheDir = (host: ServiceHost): string => {
  const xdg = host.env.XDG_CACHE_HOME?.trim();
  return xdg === undefined || xdg === '' ? join(host.home, '.cache') : xdg;
};

function unitWord(arg: string): string {
  const escaped = arg.replaceAll('%', '%%');
  if (PLAIN_WORD.test(arg)) return escaped;
  return `"${escaped.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

export function systemdUnit(host: ServiceHost, exec: string[], target: string): string {
  const env = carriedEnv(host.env).map(([key, value]) => `Environment=${unitWord(`${key}=${value}`)}`);
  return [
    '[Unit]',
    'Description=Metro daemon (metro serve)',
    'After=network-online.target tailscaled.service',
    'Wants=network-online.target',
    '',
    '[Service]',
    `ExecStart=${exec.map(unitWord).join(' ')}`,
    'Restart=always',
    'RestartSec=2',
    `WorkingDirectory=${unitWord(host.home)}`,
    ...env,
    '',
    '[Install]',
    `WantedBy=${target}`,
    '',
  ].join('\n');
}

const xml = (text: string): string =>
  text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');

export function launchdPlist(host: ServiceHost, exec: string[], logFile: string): string {
  const env = carriedEnv(host.env).map(([key, value]) => `    <key>${xml(key)}</key><string>${xml(value)}</string>`);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    `  <key>Label</key><string>${LABEL}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    ...exec.map((arg) => `    <string>${xml(arg)}</string>`),
    '  </array>',
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    ...env,
    '  </dict>',
    `  <key>WorkingDirectory</key><string>${xml(host.home)}</string>`,
    '  <key>RunAtLoad</key><true/>',
    '  <key>KeepAlive</key><true/>',
    `  <key>StandardOutPath</key><string>${xml(logFile)}</string>`,
    `  <key>StandardErrorPath</key><string>${xml(logFile)}</string>`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

function systemdPlan(host: ServiceHost, exec: string[]): ServicePlan {
  const system = host.uid === 0;
  const ctl = system ? ['systemctl'] : ['systemctl', '--user'];
  const file = system
    ? `/etc/systemd/system/${SERVICE}.service`
    : join(host.home, '.config', 'systemd', 'user', `${SERVICE}.service`);
  return {
    kind: 'systemd',
    file,
    content: systemdUnit(host, exec, system ? 'multi-user.target' : 'default.target'),
    dirs: [],
    install: [{ args: [...ctl, 'daemon-reload'] }, { args: [...ctl, 'enable', '--now', SERVICE] }],
    uninstall: [{ args: [...ctl, 'disable', '--now', SERVICE], mayFail: true }],
    reload: [{ args: [...ctl, 'daemon-reload'], mayFail: true }],
    status: { args: [...ctl, 'is-active', SERVICE], mayFail: true },
    hints: [
      `Logs:  journalctl ${system ? '' : '--user '}-u ${SERVICE} -f`,
      ...(system
        ? []
        : [`A user service stops with your login session; keep it up without one:  loginctl enable-linger ${host.user}`]),
    ],
  };
}

function launchdPlan(host: ServiceHost, exec: string[]): ServicePlan {
  const file = join(host.home, 'Library', 'LaunchAgents', `${LABEL}.plist`);
  const domain = `gui/${String(host.uid)}`;
  const logFile = join(cacheDir(host), 'metro', 'serve', 'service.log');
  return {
    kind: 'launchd',
    file,
    content: launchdPlist(host, exec, logFile),
    dirs: [dirname(logFile)],
    install: [
      { args: ['launchctl', 'bootout', `${domain}/${LABEL}`], mayFail: true },
      { args: ['launchctl', 'bootstrap', domain, file] },
    ],
    uninstall: [{ args: ['launchctl', 'bootout', `${domain}/${LABEL}`], mayFail: true }],
    reload: [],
    status: { args: ['launchctl', 'print', `${domain}/${LABEL}`], mayFail: true },
    hints: [`Logs:  tail -f ${logFile}`],
  };
}

export function servicePlan(host: ServiceHost, serveArgs: string[]): ServicePlan {
  const exec = [host.node, host.cli, 'serve', ...serveArgs];
  if (host.platform === 'linux') return systemdPlan(host, exec);
  if (host.platform === 'darwin') return launchdPlan(host, exec);
  throw new Error(`metro service supports Linux (systemd) and macOS (launchd), not ${host.platform}`);
}

function install(serveArgs: string[], deps: ServiceDeps): number {
  const { owner } = parseServeArgs(serveArgs);
  deps.preflight(owner);
  const pid = deps.running();
  if (pid !== null)
    throw new Error(
      `a metro serve is running on this machine (pid ${String(pid)}). Stop it first (metro stop), then install: the service takes over from there`,
    );
  const plan = servicePlan(deps.host, serveArgs);
  for (const dir of plan.dirs) deps.mkdir(dir);
  deps.write(plan.file, plan.content);
  for (const command of plan.install) deps.run(command);
  deps.out(
    `Installed ${plan.file}: metro serve now starts at boot and after a crash, and the Server page on metro.box can stop, start and restart it.`,
  );
  for (const hint of plan.hints) deps.out(hint);
  return 0;
}

function uninstall(deps: ServiceDeps): number {
  const plan = servicePlan(deps.host, []);
  if (!deps.exists(plan.file)) {
    deps.out('metro is not installed as a service on this machine');
    return 1;
  }
  for (const command of plan.uninstall) deps.run(command);
  deps.remove(plan.file);
  for (const command of plan.reload) deps.run(command);
  deps.out(`Removed ${plan.file}; a running daemon was stopped, and metro serve no longer starts on its own`);
  return 0;
}

function status(deps: ServiceDeps): number {
  const plan = servicePlan(deps.host, []);
  if (!deps.exists(plan.file)) {
    deps.out(`not installed (metro service install writes ${plan.file})`);
    return 1;
  }
  const active = deps.run(plan.status).status === 0;
  deps.out(
    active
      ? `running as a ${plan.kind} service (${plan.file})`
      : `installed as a ${plan.kind} service (${plan.file}), not running`,
  );
  return active ? 0 : 1;
}

function realDeps(): ServiceDeps {
  const who = userInfo();
  return {
    host: {
      platform: platform(),
      uid: who.uid,
      user: who.username,
      home: homedir(),
      node: process.execPath,
      cli: resolve(process.argv[1] ?? ''),
      env: process.env,
    },
    run: (command) => {
      const [bin = '', ...args] = command.args;
      const result = spawnSync(bin, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      const code = result.status ?? 1;
      if (code !== 0 && command.mayFail !== true) {
        const said = [result.stderr, result.stdout, result.error?.message].find((t) => typeof t === 'string' && t.trim() !== '') ?? '';
        throw new Error(`${command.args.join(' ')} failed (exit ${String(code)}): ${said.trim()}`);
      }
      return { status: code, output: `${result.stdout}${result.stderr}` };
    },
    running: serveLockedBy,
    preflight: (owner) => {
      requireOwner(owner);
      findBun();
      findTailscale();
    },
    mkdir: (dir) => {
      mkdirSync(dir, { recursive: true });
    },
    write: (file, content) => {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, content, { mode: 0o644 });
    },
    remove: (file) => {
      rmSync(file, { force: true });
    },
    exists: existsSync,
    out: (line) => {
      process.stderr.write(`${line}\n`);
    },
  };
}

export function service(argv: string[], deps: ServiceDeps = realDeps()): Promise<number> {
  const [verb, ...rest] = argv;
  if (verb === 'install') return Promise.resolve(install(rest, deps));
  if (verb === 'uninstall' && rest.length === 0) return Promise.resolve(uninstall(deps));
  if (verb === 'status' && rest.length === 0) return Promise.resolve(status(deps));
  throw new Error(USAGE);
}
