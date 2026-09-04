import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { agentsDir } from './local.js';
import { currentVersion } from './version.js';
import { serveLockedBy, serveStateDir } from './control.js';
import { findBun, localPort, SERVER_ENTRY, spawnPlan, type DaemonPlan } from './runtime.js';
import { prepareRuntime, type PreparedRuntime } from './runtime-install.js';

const SCRUBBED = new Set(['METRO_RUN_TOKEN', 'METRO_AGENT', 'DATABASE_URL']);
const PORT_FLAG = /^--port=(.*)$/;
const OWNER_FLAG = /^--owner=(.*)$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const USAGE = 'usage: metro serve [--port <n>] [--tunnel [quick|tailscale]] [--owner <address>]';
const TUNNEL_FLAG = /^--tunnel=(.*)$/;
const TAILSCALE_APP = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';

export type TunnelKind = 'quick' | 'tailscale';

interface ServeOptions {
  runtime: PreparedRuntime;
  port: number;
  tunnel: TunnelKind | null;
  tailscaleBin?: string;
  owner: string | null;
}

interface ServeArgs {
  port: number;
  tunnel: TunnelKind | null;
  owner: string | null;
}

function portOf(raw: string | undefined): number {
  const n = Number(raw);
  if (raw === undefined || raw === '' || !Number.isInteger(n) || n < 1 || n > 65535)
    throw new Error(`'${raw ?? ''}' is not a port — ${USAGE}`);
  return n;
}

function tunnelOf(raw: string | undefined): TunnelKind {
  if (raw === undefined || raw === '' || raw === 'quick') return 'quick';
  if (raw === 'tailscale') return 'tailscale';
  throw new Error(`'${raw}' is not a tunnel kind (quick or tailscale) — ${USAGE}`);
}

function tunnelFlag(argv: string[], i: number): { kind: TunnelKind; consumed: number } | null {
  const arg = argv[i] ?? '';
  const inline = TUNNEL_FLAG.exec(arg);
  if (inline) return { kind: tunnelOf(inline[1]), consumed: 0 };
  if (arg !== '--tunnel') return null;
  const next = argv[i + 1];
  const takesValue = next !== undefined && !next.startsWith('-');
  return { kind: tunnelOf(takesValue ? next : undefined), consumed: takesValue ? 1 : 0 };
}

function ownerOf(raw: string | undefined): string {
  if (raw === undefined || !ADDRESS.test(raw))
    throw new Error(`'${raw ?? ''}' is not an Ethereum address — ${USAGE}`);
  return raw.toLowerCase();
}

export function parseServeArgs(argv: string[]): ServeArgs {
  let port = localPort();
  let tunnel: TunnelKind | null = null;
  let owner: string | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    const tunnelArg = tunnelFlag(argv, i);
    if (tunnelArg) {
      tunnel = tunnelArg.kind;
      i += tunnelArg.consumed;
      continue;
    }
    const inlineOwner = OWNER_FLAG.exec(arg);
    if (inlineOwner) {
      owner = ownerOf(inlineOwner[1]);
      continue;
    }
    if (arg === '--owner') {
      owner = ownerOf(argv[i + 1]);
      i += 1;
      continue;
    }
    const inline = PORT_FLAG.exec(arg);
    if (inline) {
      port = portOf(inline[1]);
      continue;
    }
    if (arg === '--port' || arg === '-p') {
      port = portOf(argv[i + 1]);
      i += 1;
      continue;
    }
    throw new Error(`unknown argument '${arg}' — ${USAGE}`);
  }
  return { port, tunnel, owner };
}

export function requireOwner(owner: string | null, dir = agentsDir()): void {
  if (owner !== null || existsSync(join(dir, '.owner'))) return;
  throw new Error(
    'no owner is set for this machine, so no wallet could sign in.\n' +
      'Pass the wallet that owns it once; it is remembered in ' +
      join(dir, '.owner') +
      ':\n  metro serve --owner <address>',
  );
}

function tailscaleStatus(bin: string): { ok: true } | { ok: false; state: string } {
  const run = spawnSync(bin, ['status', '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  if (run.error !== undefined || run.status !== 0) return { ok: false, state: 'not running' };
  try {
    const parsed = JSON.parse(run.stdout) as { BackendState?: unknown };
    return parsed.BackendState === 'Running' ? { ok: true } : { ok: false, state: String(parsed.BackendState) };
  } catch {
    return { ok: false, state: 'unreadable' };
  }
}

export function findTailscale(candidates = ['tailscale', TAILSCALE_APP]): string {
  const bin = candidates.find(
    (c) => spawnSync(c, ['version'], { stdio: 'ignore' }).status === 0,
  );
  if (bin === undefined)
    throw new Error(
      'metro serve --tunnel tailscale needs Tailscale on this machine.\n' +
        'macOS:  brew install --cask tailscale   (or the App Store app)\n' +
        'Linux:  curl -fsSL https://tailscale.com/install.sh | sh\n' +
        'Then sign the machine in:  tailscale up',
    );
  const status = tailscaleStatus(bin);
  if (!status.ok)
    throw new Error(
      `Tailscale is installed but this machine is not connected (${status.state}). Sign it in first:  tailscale up\n` +
        'Funnel also has to be enabled once on your tailnet: https://tailscale.com/kb/1223/funnel',
    );
  return bin;
}

function findCloudflared(): void {
  const found = spawnSync('cloudflared', ['--version'], { stdio: 'ignore' });
  if (found.error !== undefined || found.status !== 0)
    throw new Error(
      'metro serve --tunnel needs cloudflared, which is not on PATH.\n' +
        'Debian/Ubuntu (it is not in the distro repos; this adds Cloudflare\'s signed one):\n' +
        '  sudo mkdir -p --mode=0755 /usr/share/keyrings\n' +
        '  curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null\n' +
        "  echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' | sudo tee /etc/apt/sources.list.d/cloudflared.list\n" +
        '  sudo apt-get update && sudo apt-get install cloudflared\n' +
        'macOS:  brew install cloudflared\n' +
        'Others: https://pkg.cloudflare.com/',
    );
}

export function servePlan(opts: ServeOptions): DaemonPlan {
  const env: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !SCRUBBED.has(key)),
  );
  return {
    command: findBun(),
    args: [SERVER_ENTRY],
    cwd: opts.runtime.dir,
    env: {
      ...env,
      METRO_MODE: 'local',
      METRO_VERSION: currentVersion(),
      METRO_CLI_BIN: process.argv[1] ?? '',
      METRO_WEBHOOK_PORT: String(opts.port),
      METRO_HTTP_HOST: process.env.METRO_HTTP_HOST ?? '127.0.0.1',
      METRO_TRAINS_DIR: opts.runtime.trains,
      ...(opts.runtime.manifest === null
        ? {}
        : { METRO_RUNTIME_STORE: opts.runtime.dir, METRO_RUNTIME_MANIFEST: opts.runtime.manifest }),
      METRO_STATE_DIR: process.env.METRO_STATE_DIR ?? serveStateDir(),
      ...(opts.tunnel === null ? {} : { METRO_TUNNEL: opts.tunnel }),
      ...(opts.tailscaleBin === undefined ? {} : { METRO_TAILSCALE_BIN: opts.tailscaleBin }),
      ...(opts.owner === null ? {} : { METRO_OWNER: opts.owner }),
    },
  };
}

export function serve(argv: string[]): Promise<number> {
  const { port, tunnel, owner } = parseServeArgs(argv);
  const running = serveLockedBy();
  if (running !== null)
    throw new Error(
      `a metro serve daemon is already running on this machine (pid ${String(running)}). ` +
        'Stop it first: metro stop',
    );
  requireOwner(owner);
  if (tunnel === 'quick') findCloudflared();
  const tailscaleBin = tunnel === 'tailscale' ? findTailscale() : undefined;
  process.stderr.write(
    `Starting a metro daemon of your own on http://127.0.0.1:${String(port)}\n`,
  );
  return spawnPlan(() =>
    servePlan({ runtime: prepareRuntime(), port, tunnel, owner, ...(tailscaleBin === undefined ? {} : { tailscaleBin }) }),
  );
}
