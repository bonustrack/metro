import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { runChild } from './child.js';
import { headlessEnv, NO_UPDATES } from './claude-env.js';
import { localAgent } from './local.js';
import { withLock } from './lock.js';
import { currentModel, permissionMode, systemPrompt, type PermissionMode } from './route.js';
import { installDependencies, ranges, readOrNull } from './runtime-install.js';
import { findBun, localPort, runtimeDir } from './runtime.js';

export const RUNNER_SOURCES = 'sdk-runner';
const STAMP = 'runner.json';
const ENTRY = join('src', 'main.ts');
const METRO_MODULES = join('node_modules', '@metro-labs');
const BUNFIG = '[install]\noptional = false\npeer = false\n';
const SDK = '@anthropic-ai/claude-agent-sdk';
const PREPARE_LOCK = '.prepare.lock';
const PREPARE_WAIT = { staleMs: 20 * 60_000, waitMs: 20 * 60_000, pollMs: 250 };

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
  return {
    version: typeof raw.version === 'string' ? raw.version : '',
    dependencies: ranges(raw.dependencies),
  };
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

function stageSources(sources: string, store: string, stamp: string): void {
  mkdirSync(store, { recursive: true });
  if (readOrNull(join(store, STAMP)) !== stamp || !existsSync(join(store, ENTRY))) {
    rmSync(join(store, 'src'), { recursive: true, force: true });
    rmSync(join(store, METRO_MODULES), { recursive: true, force: true });
    cpSync(join(sources, 'src'), join(store, 'src'), { recursive: true });
    cpSync(join(sources, METRO_MODULES), join(store, METRO_MODULES), { recursive: true });
    writeFileSync(join(store, STAMP), stamp);
  }
  if (readOrNull(join(store, 'bunfig.toml')) !== BUNFIG) writeFileSync(join(store, 'bunfig.toml'), BUNFIG);
}

export function prepareRunner(opts: RunnerPrepare = {}): PreparedRunner {
  const store = opts.store ?? runnerStore();
  const log =
    opts.log ??
    ((line: string): void => {
      process.stderr.write(`metro agent: ${line}\n`);
    });
  const waiting = (): void => {
    log(`waiting for another preparation of ${store} to finish`);
  };
  return withLock(join(store, PREPARE_LOCK), { ...PREPARE_WAIT, waiting }, () => prepareIn(store, opts, log));
}

function prepareIn(store: string, opts: RunnerPrepare, log: (line: string) => void): PreparedRunner {
  const sources = opts.sources ?? join(runtimeDir(), RUNNER_SOURCES);
  const stamp = readFileSync(join(sources, STAMP), 'utf8');
  stageSources(sources, store, stamp);
  const pkg = opts.claude ?? claudePackage();
  const claude = join(store, 'node_modules', ...pkg.name.split('/'), pkg.binary);
  const marker = join(store, 'node_modules', '.metro-installed');
  if (!existsSync(claude)) rmSync(marker, { force: true });
  installDependencies(store, runnerDependencies(readRunnerManifest(stamp), pkg), opts.bun ?? findBun(), log);
  if (!existsSync(claude)) {
    rmSync(marker, { force: true });
    throw new Error(`The Claude Code binary bundled with the Agent SDK is missing at ${claude}. Try preparing the runner again.`);
  }
  return { entry: join(store, ENTRY), claude };
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

function checkBinary(bin: string): void {
  const run = spawnSync(bin, ['--version'], { env: { ...process.env, ...NO_UPDATES }, stdio: 'ignore', timeout: 30_000 });
  if (run.error !== undefined || run.status !== 0) throw new Error(`Runner preflight failed: ${bin} cannot run (${run.error?.message ?? `exit ${String(run.status)}`}).`);
}

export function prepareAgentRunner(opts: RunnerPrepare = {}): void {
  const prepared = prepareRunner(opts);
  try {
    checkBinary(prepared.claude);
  } catch (err) {
    rmSync(join(opts.store ?? runnerStore(), 'node_modules', '.metro-installed'), { force: true });
    throw err;
  }
}

const prepareOnly = (args: string[]): boolean => args[0] === '--prepare' && (args.length === 1 || (args.length === 2 && args[1] === 'sdk'));

export async function agentSession(args: string[] = []): Promise<number> {
  if (prepareOnly(args)) {
    prepareAgentRunner();
    return 0;
  }
  if (args.length > 0) throw new Error('metro agent accepts only --prepare');
  process.chdir(homedir());
  const agent = localAgent();
  if (agent === null) throw new Error('metro agent needs the agent of this machine, and there is none yet');
  const bun = findBun();
  const runner = prepareRunner({ bun });
  process.stderr.write('metro agent: this agent runs as one Agent SDK session: a light front talks, background workers do the work\n');
  const env = { ...(await headlessEnv(runner.claude, 'metro agent')), ...runnerEnv(agent.key, localPort(), currentModel(), permissionMode(), systemPrompt(), runner.claude) };
  return runChild(bun, [runner.entry], env);
}
