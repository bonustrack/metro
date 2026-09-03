import { homedir } from 'node:os';
import { join } from 'node:path';
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
const USAGE = 'usage: metro serve [--port <n>]';

export interface ServeOptions {
  dir: string;
  port: number;
}

function portOf(raw: string | undefined): number {
  const n = Number(raw);
  if (raw === undefined || raw === '' || !Number.isInteger(n) || n < 1 || n > 65535)
    throw new Error(`'${raw ?? ''}' is not a port — ${USAGE}`);
  return n;
}

export function parseServeArgs(argv: string[]): { port: number } {
  let port = localPort();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
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
  return { port };
}

export function serveStateDir(): string {
  const xdg = process.env.XDG_CACHE_HOME?.trim();
  const base = xdg === undefined || xdg === '' ? join(homedir(), '.cache') : xdg;
  return join(base, 'metro', 'serve');
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
    },
  };
}

export function serve(argv: string[]): Promise<number> {
  const { port } = parseServeArgs(argv);
  const plan = servePlan({ dir: runtimeDir(), port });
  process.stderr.write(
    `Starting a metro daemon of your own on http://127.0.0.1:${String(port)}\n`,
  );
  return spawnPlan(plan);
}
