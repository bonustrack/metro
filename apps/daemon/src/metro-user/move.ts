import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ApiError } from '@metro-labs/http/api-error';
import { METRO_VERSION } from '@metro-labs/core/version';
import { AGENT_NAME } from '../agent-user/user.js';
import { HELPER_PATH, helperScript, METRO_HOME, METRO_USER, SUDOERS_PATH, sudoersText } from './helper-script.js';
import { runningAsRoot } from './privilege.js';

export const UNIT_FILE = '/etc/systemd/system/metro.service';
export const MOVE_DIR = '/var/lib/metro-move';
export const MOVE_LOG = '/var/log/metro-move.log';
const PREFIX = `${METRO_HOME}/.npm-global`;
const CLI = `${PREFIX}/lib/node_modules/@stage-labs/metro/dist/cli.js`;

const which = (bin: string): string | null => {
  const run = spawnSync('sh', ['-c', `command -v ${bin}`], { encoding: 'utf8' });
  const path = run.status === 0 ? run.stdout.trim() : '';
  if (path === '') return null;
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
};

export interface UnitFacts {
  serveArgs: string[];
  env: string[];
  port: string;
}

export function unitFacts(unit: string): UnitFacts {
  const exec = /^ExecStart=(.*)$/m.exec(unit)?.[1] ?? '';
  const words = [...exec.matchAll(/"((?:[^"\\]|\\.)*)"|(\S+)/g)].map((m) => (m[1] ?? m[2] ?? '').replace(/\\(.)/g, '$1'));
  const at = words.indexOf('serve');
  if (at < 0) throw new ApiError('the metro service does not run `metro serve`; move it by hand', 409);
  const env = [...unit.matchAll(/^Environment=(.*)$/gm)].map((m) => m[1] ?? '').filter((e) => /^"?METRO_/.test(e) && !/^"?METRO_(AGENTS_DIR|RUNTIME_STORE)=/.test(e));
  const portArg = words[words.indexOf('--port') + 1];
  const envPort = /METRO_WEBHOOK_PORT=(\d+)/.exec(env.join(' '))?.[1];
  return { serveArgs: words.slice(at + 1), env, port: (words.includes('--port') ? portArg : envPort) ?? '8420' };
}

const ESCAPED_QUOTE = '\'\\\'\'';
const shellWord = (w: string): string => `'${w.replace(/'/g, ESCAPED_QUOTE)}'`;
const unitWord = (w: string): string => (/^[A-Za-z0-9_/.:=+@,-]+$/.test(w) ? w : `"${w.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);

export function metroUnit(node: string, facts: UnitFacts): string {
  return [
    '[Unit]',
    'Description=Metro daemon (metro serve)',
    'After=network-online.target tailscaled.service',
    'Wants=network-online.target',
    '',
    '[Service]',
    `User=${METRO_USER}`,
    `Group=${METRO_USER}`,
    `ExecStart=${[node, CLI, 'serve', ...facts.serveArgs].map(unitWord).join(' ')}`,
    'Restart=always',
    'RestartSec=2',
    'OOMPolicy=continue',
    'WorkingDirectory=/',
    `Environment=HOME=${METRO_HOME}`,
    `Environment=PATH=${PREFIX}/bin:/usr/local/bin:/usr/bin:/bin`,
    `Environment=NPM_CONFIG_PREFIX=${PREFIX}`,
    ...facts.env.map((e) => `Environment=${e}`),
    '',
    '[Install]',
    'WantedBy=multi-user.target',
    '',
  ].join('\n');
}

export function moveScript(port: string, spec: string, bun: string): string {
  return [
    '#!/bin/sh',
    'set -u',
    `exec >> ${MOVE_LOG} 2>&1`,
    'echo "--- metro move $(date -Is)"',
    `OLD=/root/.metro; NEW=${METRO_HOME}/.metro; DIR=${MOVE_DIR}`,
    'fail() { echo "FAILED: $*"; echo failed > "$DIR/state"; exit 1; }',
    'healthy() {',
    '  i=0; while [ $i -lt 60 ]; do',
    `    if curl -fsS -m 3 http://127.0.0.1:${port}/health >/dev/null 2>&1 && [ "$(ps -o user= -p "$(systemctl show metro -p MainPID --value)")" = "$1" ]; then return 0; fi`,
    '    i=$((i+1)); sleep 2; done; return 1; }',
    'echo moving > "$DIR/state"',
    `id ${METRO_USER} >/dev/null 2>&1 || useradd --system --create-home --home-dir ${METRO_HOME} --shell /usr/sbin/nologin ${METRO_USER} || fail "useradd"`,
    `usermod -aG systemd-journal ${METRO_USER} || true`,
    `mkdir -p ${METRO_HOME} && chown ${METRO_USER}:${METRO_USER} ${METRO_HOME} && chmod 711 ${METRO_HOME}`,
    `B=${shellWord(bun)}; case "$B" in /root/*) install -m 755 "$B" /usr/local/bin/bun || fail "bun";; esac`,
    `su -s /bin/sh ${METRO_USER} -c ${shellWord(`cd / && npm install --global --prefix ${PREFIX} ${spec}`)} || fail "npm install for ${METRO_USER}"`,
    `for bin in node bun tailscale npm; do su -s /bin/sh ${METRO_USER} -c ${shellWord(`PATH=${PREFIX}/bin:/usr/local/bin:/usr/bin:/bin command -v "$1" >/dev/null`)} sh "$bin" || fail "${METRO_USER} cannot find $bin"; done`,
    `tailscale set --operator=${METRO_USER} || fail "tailscale operator"`,
    `cp ${UNIT_FILE} "$DIR/metro.service.root" || fail "unit backup"`,
    'systemctl stop metro',
    'if [ -e "$NEW" ]; then mv "$NEW" "$NEW.old-$(date +%s)"; fi',
    'mv "$OLD" "$NEW" || { systemctl start metro; fail "move"; }',
    'rm -f "$NEW/runtime/runtime.json"',
    `chown -R ${METRO_USER}:${METRO_USER} ${METRO_HOME} && chmod 711 ${METRO_HOME} && chmod 700 "$NEW"`,
    `install -m 644 "$DIR/metro.service.new" ${UNIT_FILE}`,
    'systemctl daemon-reload && systemctl start metro',
    `if healthy ${METRO_USER}; then echo done > "$DIR/state"; echo "metro runs as ${METRO_USER}"; exit 0; fi`,
    'echo "not healthy as metro, putting everything back"',
    'systemctl stop metro',
    'mv "$NEW" "$OLD" && chown -R root:root "$OLD"',
    `install -m 644 "$DIR/metro.service.root" ${UNIT_FILE}`,
    'systemctl daemon-reload && systemctl start metro',
    'healthy root && fail "Metro did not start as metro; it runs as root again" || fail "Metro did not start as metro, and the way back did not answer either"',
    '',
  ].join('\n');
}

function whichOrFail(bin: string): string {
  const found = which(bin);
  if (found === null) throw new ApiError(`${bin} is missing on this box`, 409);
  return found;
}

const requireTools = (): void => {
  for (const bin of ['sudo', 'visudo', 'tailscale', 'curl', 'npm']) whichOrFail(bin);
};

function preflight(): { node: string; bun: string; unit: string } {
  if (!runningAsRoot()) throw new ApiError('only a Metro running as root can move itself', 409);
  if (!existsSync(UNIT_FILE)) throw new ApiError('this box does not run Metro as the systemd service `metro`', 409);
  if (process.env.METRO_AGENTS_DIR !== undefined && process.env.METRO_AGENTS_DIR !== '') throw new ApiError('METRO_AGENTS_DIR is set; move this box by hand', 409);
  if (homedir() !== '/root') throw new ApiError(`Metro keeps its files in ${homedir()}, not /root; move this box by hand`, 409);
  const node = which('node');
  if (node === null || node.startsWith('/root/')) throw new ApiError('Node must be installed for every user (not under /root) before the move', 409);
  requireTools();
  return { node, bun: whichOrFail('bun'), unit: readFileSync(UNIT_FILE, 'utf8') };
}

function installHelper(): void {
  mkdirSync('/usr/local/lib/metro', { recursive: true, mode: 0o755 });
  writeFileSync(HELPER_PATH, helperScript(), { mode: 0o755 });
  chmodSync(HELPER_PATH, 0o755);
  const draft = join(MOVE_DIR, 'sudoers');
  writeFileSync(draft, sudoersText(AGENT_NAME), { mode: 0o440 });
  const check = spawnSync('visudo', ['-cf', draft], { encoding: 'utf8' });
  if (check.status !== 0) throw new ApiError(`the sudo rules did not validate: ${check.stdout}${check.stderr}`, 500);
  spawnSync('install', ['-m', '440', draft, SUDOERS_PATH]);
}

export function startMove(spec = `@stage-labs/metro@${METRO_VERSION}`): { log: string } {
  const { node, bun, unit } = preflight();
  const facts = unitFacts(unit);
  mkdirSync(MOVE_DIR, { recursive: true, mode: 0o700 });
  installHelper();
  writeFileSync(join(MOVE_DIR, 'metro.service.new'), metroUnit(node, facts), { mode: 0o600 });
  writeFileSync(join(MOVE_DIR, 'move.sh'), moveScript(facts.port, spec, bun), { mode: 0o700 });
  writeFileSync(join(MOVE_DIR, 'state'), 'starting\n');
  const run = spawnSync('systemd-run', ['--unit=metro-move', '--collect', '--quiet', 'sh', join(MOVE_DIR, 'move.sh')], { encoding: 'utf8' });
  if (run.status !== 0) throw new ApiError(`could not start the move: ${run.stderr.trim()}`, 500);
  return { log: MOVE_LOG };
}

export function moveState(): string | null {
  try {
    return readFileSync(join(MOVE_DIR, 'state'), 'utf8').trim();
  } catch {
    return null;
  }
}
