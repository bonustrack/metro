import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
      'metro serve needs Bun, which is not on PATH.\n' +
        'Install it with:  curl -fsSL https://bun.sh/install | bash',
    );
  return 'bun';
}

export const localPort = (): number =>
  Number(process.env.METRO_WEBHOOK_PORT) || 8420;

export const localUrl = (): string =>
  `http://127.0.0.1:${String(localPort())}`;

export interface DaemonPlan {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
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
