import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { serveLockedBy, serveStateDir } from './control.js';
import {
  findBun,
  localPort,
  runtimeDir,
  SERVER_ENTRY,
  spawnPlan,
  type DaemonPlan,
} from './runtime.js';

const SCRUBBED = new Set(['METRO_RUN_TOKEN', 'METRO_AGENT', 'DATABASE_URL']);
const PORT_FLAG = /^--port=(.*)$/;
const USAGE = 'usage: metro serve [--port <n>] [--tunnel]';

export interface ServeOptions {
  dir: string;
  port: number;
  tunnel: boolean;
}

export interface ServeArgs {
  port: number;
  tunnel: boolean;
}

function portOf(raw: string | undefined): number {
  const n = Number(raw);
  if (raw === undefined || raw === '' || !Number.isInteger(n) || n < 1 || n > 65535)
    throw new Error(`'${raw ?? ''}' is not a port — ${USAGE}`);
  return n;
}

export function parseServeArgs(argv: string[]): ServeArgs {
  let port = localPort();
  let tunnel = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    if (arg === '--tunnel') {
      tunnel = true;
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
  return { port, tunnel };
}

export function findCloudflared(): void {
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
    cwd: opts.dir,
    env: {
      ...env,
      METRO_MODE: 'local',
      METRO_WEBHOOK_PORT: String(opts.port),
      METRO_HTTP_HOST: process.env.METRO_HTTP_HOST ?? '127.0.0.1',
      METRO_TRAINS_DIR: join(opts.dir, 'trains'),
      METRO_STATE_DIR: process.env.METRO_STATE_DIR ?? serveStateDir(),
      ...(opts.tunnel ? { METRO_TUNNEL: 'quick' } : {}),
    },
  };
}

export function serve(argv: string[]): Promise<number> {
  const { port, tunnel } = parseServeArgs(argv);
  const running = serveLockedBy();
  if (running !== null)
    throw new Error(
      `a metro serve daemon is already running on this machine (pid ${String(running)}). ` +
        'Stop it first: metro stop',
    );
  if (tunnel) findCloudflared();
  const plan = servePlan({ dir: runtimeDir(), port, tunnel });
  process.stderr.write(
    `Starting a metro daemon of your own on http://127.0.0.1:${String(port)}\n`,
  );
  return spawnPlan(plan);
}
