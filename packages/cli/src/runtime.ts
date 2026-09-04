import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { metroUrl } from './store.js';

const AGENT_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{10}$/;
export const SERVER_ENTRY = join(
  'node_modules',
  '@metro-labs',
  'mcp',
  'src',
  'server.ts',
);

export class MissingRuntime extends Error {}

export function runtimeDir(): string {
  const explicit = process.env.METRO_RUNTIME_DIR?.trim();
  const dir =
    explicit !== undefined && explicit !== ''
      ? explicit
      : join(dirname(dirname(fileURLToPath(import.meta.url))), 'runtime');
  if (!existsSync(join(dir, SERVER_ENTRY)))
    throw new MissingRuntime(
      `no metro daemon at ${dir}. Reinstall with: npm i -g @stage-labs/metro@beta`,
    );
  return dir;
}

class MissingBun extends Error {}

export function assertAgentId(id: string | undefined): string {
  if (id === undefined || !AGENT_RE.test(id))
    throw new Error(
      `'${id ?? ''}' is not an agent id — copy it from the agent's page in the web UI`,
    );
  return id;
}

export function findBun(): string {
  const found = spawnSync('bun', ['--version'], { stdio: 'ignore' });
  if (found.error !== undefined || found.status !== 0)
    throw new MissingBun(
      'metro start needs Bun, which is not on PATH.\n' +
        'Install it with:  curl -fsSL https://bun.sh/install | bash',
    );
  return 'bun';
}

function tokenPath(agentId: string): string {
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  const base = xdg === undefined || xdg === '' ? join(homedir(), '.config') : xdg;
  return join(base, 'metro', `runtime-${agentId}.json`);
}

export function readRunToken(agentId: string): string | null {
  const fromEnv = process.env.METRO_RUN_TOKEN?.trim();
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  try {
    const parsed = JSON.parse(readFileSync(tokenPath(agentId), 'utf8')) as {
      token?: unknown;
      url?: unknown;
    };
    if (typeof parsed.token !== 'string' || parsed.token === '') return null;
    return parsed.url === metroUrl() ? parsed.token : null;
  } catch {
    return null;
  }
}

export function writeRunToken(agentId: string, token: string): void {
  const path = tokenPath(agentId);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify({ token, url: metroUrl() }, null, 2));
  chmodSync(path, 0o600);
}

const PROBE_TIMEOUT_MS = 15_000;

type RunTokenState = 'ok' | 'stale' | 'unreachable';

export async function runTokenState(token: string): Promise<RunTokenState> {
  let res: Response;
  try {
    res = await fetch(`${metroUrl()}/api/run/config`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      redirect: 'manual',
    });
  } catch {
    return 'unreachable';
  }
  await res.arrayBuffer().catch(() => undefined);
  if (res.ok) return 'ok';
  return res.status === 401 || res.status === 403 || res.status === 409
    ? 'stale'
    : 'unreachable';
}

export const localPort = (): number =>
  Number(process.env.METRO_WEBHOOK_PORT) || 8420;

export const localUrl = (): string =>
  `http://127.0.0.1:${String(localPort())}`;

interface SpawnOptions {
  agentId: string;
  token: string;
  dir: string;
}

export interface DaemonPlan {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export function daemonPlan(opts: SpawnOptions): DaemonPlan {
  return {
    command: findBun(),
    args: [SERVER_ENTRY],
    cwd: opts.dir,
    env: {
      ...process.env,
      METRO_RUN_TOKEN: opts.token,
      METRO_AGENT: opts.agentId,
      METRO_URL: metroUrl(),
      METRO_HTTP_HOST: process.env.METRO_HTTP_HOST ?? '127.0.0.1',
      METRO_TRAINS_DIR: join(opts.dir, 'trains'),
    },
  };
}

export function runDaemon(agentId: string, plan: DaemonPlan): Promise<number> {
  process.stderr.write(`Starting metro for ${agentId}\n`);
  return spawnPlan(plan);
}

export function spawnPlan(plan: DaemonPlan): Promise<number> {
  const child = spawn(plan.command, plan.args, {
    cwd: plan.cwd,
    env: plan.env,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  const relay = (sig: NodeJS.Signals) => () => {
    child.kill(sig);
  };
  process.on('SIGINT', relay('SIGINT'));
  process.on('SIGTERM', relay('SIGTERM'));
  return new Promise<number>((resolve) => {
    child.on('exit', (code) => {
      resolve(code ?? 0);
    });
  });
}
