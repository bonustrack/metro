import { spawn, spawnSync } from 'node:child_process';
import { markOnboardingDone, seedChannels } from './onboarding.js';
import { writeMcpConfig, type McpConfigFile } from './mcp-config.js';
import { settingsConflicts, settingsFiles } from './claude-settings.js';
import { localAgents, pickLocalAgent } from './local.js';
import { PROVIDER_FLAGS } from './provider-flags.js';
import { localPort, localUrl } from './runtime.js';

const CHANNEL_FLAGS = ['--dangerously-load-development-channels', 'server:metro'];
const PERMISSION_FLAGS = ['--permission-mode', 'auto'];
const KEY_HEADER = 'x-metro-key';
const PROBE_MS = 3_000;

export const claudeArgs = (extra: string[], mcpConfig?: string): string[] => [
  ...CHANNEL_FLAGS,
  ...PERMISSION_FLAGS,
  ...(mcpConfig === undefined ? [] : ['--mcp-config', mcpConfig]),
  ...extra,
];

const set = (env: NodeJS.ProcessEnv, name: string): boolean => (env[name] ?? '').trim() !== '';

export function pinnedBy(env: NodeJS.ProcessEnv): string | null {
  if (set(env, 'ANTHROPIC_BASE_URL')) return 'ANTHROPIC_BASE_URL';
  return PROVIDER_FLAGS.find((flag) => set(env, flag)) ?? null;
}

export function gatewayEnv(base: NodeJS.ProcessEnv, agentKey: string | null, port: number): NodeJS.ProcessEnv {
  if (agentKey === null || pinnedBy(base) !== null) return base;
  const own = (base.ANTHROPIC_CUSTOM_HEADERS ?? '').trim();
  const mine = `${KEY_HEADER}: ${agentKey}`;
  return {
    ...base,
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${String(port)}/gateway`,
    ANTHROPIC_CUSTOM_HEADERS: own === '' ? mine : `${own}\n${mine}`,
    CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '1',
  };
}

const OWN_CREDENTIALS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];

export function credentialEnv(env: NodeJS.ProcessEnv, agentKey: string, signedIn: boolean): NodeJS.ProcessEnv {
  if (signedIn || OWN_CREDENTIALS.some((name) => set(env, name))) return env;
  return { ...env, ANTHROPIC_AUTH_TOKEN: agentKey };
}

export function claudeSignedIn(): boolean {
  const run = spawnSync('claude', ['auth', 'status', '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  if (run.error !== undefined || typeof run.stdout !== 'string') return false;
  try {
    const parsed = JSON.parse(run.stdout) as { authenticated?: unknown; loggedIn?: unknown; email?: unknown; organization?: unknown };
    return parsed.authenticated === true || parsed.loggedIn === true || typeof parsed.email === 'string' || typeof parsed.organization === 'string';
  } catch {
    return false;
  }
}

export function servingDaemon(body: unknown): boolean {
  if (typeof body !== 'object' || body === null) return false;
  const mode = body as { mode?: unknown; stopped?: unknown };
  return mode.mode === 'local' && mode.stopped !== true;
}

async function daemonServing(base = localUrl()): Promise<boolean> {
  try {
    const res = await fetch(`${base}/api/mode`, { signal: AbortSignal.timeout(PROBE_MS) });
    return res.ok && servingDaemon(await res.json());
  } catch {
    return false;
  }
}

export type Verdict = { key: string } | { skip: string };

interface AgentLike {
  id: string;
  name: string;
  key: string;
}

export function agentKey(agents: AgentLike[], wanted: string | undefined): Verdict {
  if (agents.length === 0) return { skip: 'no agent lives on this machine yet, so Claude Code talks to Anthropic directly' };
  try {
    return { key: pickLocalAgent(agents, wanted).key };
  } catch {
    return {
      skip:
        wanted === undefined || wanted === ''
          ? 'several agents live here; set METRO_AGENT=<name> to route through the daemon, Claude Code talks to Anthropic directly for now'
          : `no agent named '${wanted}' lives here, so Claude Code talks to Anthropic directly`,
    };
  }
}

function localAgentList(): AgentLike[] {
  try {
    return localAgents();
  } catch {
    return [];
  }
}

async function verdict(): Promise<Verdict> {
  const pinned = pinnedBy(process.env);
  if (pinned !== null) return { skip: `${pinned} is set, so Claude Code keeps talking to it` };
  const conflicts = settingsConflicts(settingsFiles());
  if (conflicts.length > 0) return { skip: `a settings file pins the provider (${conflicts.join(', ')}), so Claude Code keeps it` };
  const picked = agentKey(localAgentList(), process.env.METRO_AGENT);
  if ('skip' in picked) return picked;
  if (await daemonServing()) return picked;
  return { skip: 'the daemon is not serving here (stopped, or not running), so Claude Code talks to Anthropic directly' };
}

export function runClaude(args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve, reject) => {
    const leaveToChild = (): undefined => undefined;
    process.on('SIGINT', leaveToChild);
    process.on('SIGTERM', leaveToChild);
    const child = spawn('claude', args, { stdio: 'inherit', env });
    child.on('error', (err: NodeJS.ErrnoException) => {
      reject(
        new Error(
          err.code === 'ENOENT'
            ? 'the `claude` command is not on PATH — install Claude Code first'
            : err.message,
        ),
      );
    });
    child.on('exit', (code) => {
      resolve(code ?? 1);
    });
  });
}

async function servedKey(decision: Verdict): Promise<string | null> {
  if ('key' in decision) return decision.key;
  const picked = agentKey(localAgentList(), process.env.METRO_AGENT);
  if ('skip' in picked) return null;
  return (await daemonServing()) ? picked.key : null;
}

function mcpConfigFor(key: string | null, port: number): McpConfigFile | null {
  if (key === null) return null;
  const file = writeMcpConfig(key, port);
  process.stderr.write(`metro claude: the metro MCP server is loaded for this session from the daemon at http://127.0.0.1:${String(port)}/mcp, nothing to add by hand\n`);
  return file;
}

function gatewayLaunchEnv(key: string, port: number): NodeJS.ProcessEnv {
  process.stderr.write(`metro claude: inference goes through the daemon at http://127.0.0.1:${String(port)}/gateway (the Model page decides where)\n`);
  const routed = gatewayEnv(process.env, key, port);
  const env = credentialEnv(routed, key, claudeSignedIn());
  if (env !== routed)
    process.stderr.write("metro claude: Claude Code has no login of its own here, so metro's key stands in as its credential; the Model page must route to Bedrock, OpenRouter or Codex\n");
  if (seedChannels() === 'marked')
    process.stderr.write('metro claude: marked Channels as available in Claude Code cached flags, since a box that sends no telemetry never fetches them\n');
  if (markOnboardingDone() === 'marked')
    process.stderr.write("metro claude: skipped Claude Code's first-run setup, since it already has a credential here\n");
  return env;
}

export async function launchClaude(extra: string[]): Promise<number> {
  const decision = await verdict();
  const port = localPort();
  const mcp = mcpConfigFor(await servedKey(decision), port);
  try {
    if ('skip' in decision) {
      process.stderr.write(`metro claude: ${decision.skip}\n`);
      return await runClaude(claudeArgs(extra, mcp?.path), process.env);
    }
    return await runClaude(claudeArgs(extra, mcp?.path), gatewayLaunchEnv(decision.key, port));
  } finally {
    mcp?.cleanup();
  }
}
