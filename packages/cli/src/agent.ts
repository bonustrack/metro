import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { headlessEnv, runClaude } from './claude.js';
import { localAgent } from './local.js';
import { currentModel, harnessRunner, permissionMode, systemPrompt, type PermissionMode } from './route.js';
import { installDependencies } from './runtime-install.js';
import { findBun, localPort, runtimeDir } from './runtime.js';

export const RUNNER_SOURCES = 'sdk-runner';
const STAMP = 'runner.json';
const ENTRY = join('src', 'main.ts');
const METRO_MODULES = join('node_modules', '@metro-labs');
const BUNFIG = '[install]\noptional = false\npeer = false\n';
const SDK = '@anthropic-ai/claude-agent-sdk';
const NOT_THE_RUNNER =
  'the Harness runs this agent as a Claude Code session, so metro agent does not start: it would take the metro chat away from it. Choose Agent SDK as the Harness runner on metro.box first';

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

export interface ClaudePackage {
  name: string;
  binary: string;
}

function glibcMissing(): boolean {
  const report = process.report.getReport() as { header?: { glibcVersionRuntime?: string } };
  return report.header?.glibcVersionRuntime === undefined;
}

export function claudePackage(platform: string = process.platform, arch: string = process.arch, musl = platform === 'linux' && glibcMissing()): ClaudePackage {
  return { name: `${SDK}-${platform}-${arch}${musl ? '-musl' : ''}`, binary: platform === 'win32' ? 'claude.exe' : 'claude' };
}

export function runnerDependencies(manifest: RunnerManifest, pkg: ClaudePackage): Record<string, string> {
  const sdk = manifest.dependencies[SDK];
  return sdk === undefined ? manifest.dependencies : { ...manifest.dependencies, [pkg.name]: sdk };
}

export interface PreparedRunner {
  entry: string;
  claude: string;
}

export interface RunnerPrepare {
  sources?: string;
  store?: string;
  bun?: string;
  log?: (line: string) => void;
  claude?: ClaudePackage;
}

export function prepareRunner(opts: RunnerPrepare = {}): PreparedRunner {
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
  const pkg = opts.claude ?? claudePackage();
  installDependencies(store, runnerDependencies(readRunnerManifest(stamp), pkg), opts.bun ?? findBun(), log);
  return { entry: join(store, ENTRY), claude: join(store, 'node_modules', ...pkg.name.split('/'), pkg.binary) };
}

export function runnerEnv(key: string, port: number, model: string | null, mode: PermissionMode, prompt: string | null, claude: string): Record<string, string> {
  return {
    METRO_RUNNER_MCP_URL: `http://127.0.0.1:${String(port)}/mcp`,
    METRO_RUNNER_CLAUDE: claude,
    METRO_AGENT_KEY: key,
    METRO_RUNNER_PERMISSION_MODE: mode,
    ...(model === null ? {} : { METRO_RUNNER_MODEL: model }),
    ...(prompt === null ? {} : { METRO_RUNNER_PROMPT: prompt }),
  };
}

export async function agentSession(): Promise<number> {
  process.chdir(homedir());
  if (harnessRunner() !== 'sdk') throw new Error(NOT_THE_RUNNER);
  const agent = localAgent();
  if (agent === null) throw new Error('metro agent needs the agent of this machine, and there is none yet');
  const bun = findBun();
  const runner = prepareRunner({ bun });
  if (!existsSync(runner.claude)) throw new Error(`the Claude Code that comes with the Agent SDK is missing at ${runner.claude}; remove ${runnerStore()} and start again`);
  process.stderr.write('metro agent: this agent runs as one Agent SDK session: a light front talks, background workers do the work\n');
  const env = { ...(await headlessEnv()), ...runnerEnv(agent.key, localPort(), currentModel(), permissionMode(), systemPrompt(), runner.claude) };
  return runClaude([runner.entry], env, undefined, bun);
}
