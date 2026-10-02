import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { headlessEnv, runClaude } from './claude.js';
import { localAgent } from './local.js';
import { currentRoute, permissionMode, systemPrompt, type PermissionMode } from './route.js';
import { installDependencies } from './runtime-install.js';
import { findBun, localPort, runtimeDir } from './runtime.js';

export const RUNNER_SOURCES = 'sdk-runner';
const STAMP = 'runner.json';
const ENTRY = join('src', 'main.ts');
const METRO_MODULES = join('node_modules', '@metro-labs');
const BUNFIG = '[install]\noptional = false\npeer = false\n';

export interface RunnerManifest {
  version: string;
  dependencies: Record<string, string>;
}

export function runnerStore(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.METRO_RUNNER_STORE?.trim() ?? '';
  return explicit === '' ? join(homedir(), '.metro', 'sdk-runner') : explicit;
}

export function readRunnerManifest(text: string): RunnerManifest {
  const raw = JSON.parse(text) as { version?: unknown; dependencies?: unknown };
  const deps = typeof raw.dependencies === 'object' && raw.dependencies !== null ? raw.dependencies : {};
  return {
    version: typeof raw.version === 'string' ? raw.version : '',
    dependencies: Object.fromEntries(Object.entries(deps).filter((e): e is [string, string] => typeof e[1] === 'string')),
  };
}

function readOrNull(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

export interface RunnerPrepare {
  sources?: string;
  store?: string;
  bun?: string;
  log?: (line: string) => void;
}

export function prepareRunner(opts: RunnerPrepare = {}): string {
  const sources = opts.sources ?? join(runtimeDir(), RUNNER_SOURCES);
  const stamp = readFileSync(join(sources, STAMP), 'utf8');
  const store = opts.store ?? runnerStore();
  mkdirSync(store, { recursive: true });
  if (readOrNull(join(store, STAMP)) !== stamp || !existsSync(join(store, ENTRY))) {
    rmSync(join(store, 'src'), { recursive: true, force: true });
    rmSync(join(store, METRO_MODULES), { recursive: true, force: true });
    cpSync(join(sources, 'src'), join(store, 'src'), { recursive: true });
    cpSync(join(sources, METRO_MODULES), join(store, METRO_MODULES), { recursive: true });
    writeFileSync(join(store, STAMP), stamp);
  }
  if (readOrNull(join(store, 'bunfig.toml')) !== BUNFIG) writeFileSync(join(store, 'bunfig.toml'), BUNFIG);
  const log =
    opts.log ??
    ((line: string): void => {
      process.stderr.write(`metro agent: ${line}\n`);
    });
  installDependencies(store, readRunnerManifest(stamp).dependencies, opts.bun ?? findBun(), log);
  return join(store, ENTRY);
}

export function runnerEnv(key: string, port: number, route: string | null, mode: PermissionMode, prompt: string | null): Record<string, string> {
  return {
    METRO_RUNNER_MCP_URL: `http://127.0.0.1:${String(port)}/mcp`,
    METRO_AGENT_KEY: key,
    METRO_RUNNER_PERMISSION_MODE: mode,
    ...(route === null ? {} : { METRO_RUNNER_FRONT_MODEL: route, METRO_RUNNER_WORKER_MODEL: route }),
    ...(prompt === null ? {} : { METRO_RUNNER_PROMPT: prompt }),
  };
}

export async function agentSession(): Promise<number> {
  process.chdir(homedir());
  const agent = localAgent();
  if (agent === null) throw new Error('metro agent needs the agent of this machine, and there is none yet');
  const bun = findBun();
  const entry = prepareRunner({ bun });
  process.stderr.write('metro agent: this agent runs as one Agent SDK session: a light front talks, background workers do the work\n');
  const env = { ...(await headlessEnv()), ...runnerEnv(agent.key, localPort(), currentRoute(), permissionMode(), systemPrompt()) };
  return runClaude([entry], env, undefined, bun);
}
