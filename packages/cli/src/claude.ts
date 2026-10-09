import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { markOnboardingDone, seedChannels } from './onboarding.js';
import { writeMcpConfig, type McpConfigFile } from './mcp-config.js';
import { currentRoute, harnessRunner, permissionMode, routeModelEnv, systemPrompt, type PermissionMode } from './route.js';
import { settingsConflicts, settingsFiles } from './claude-settings.js';
import { localAgent, type LocalAgent } from './local.js';
import { PROVIDER_FLAGS } from './provider-flags.js';
import { localPort, localUrl } from './runtime.js';
import { keepInSession, resumeSessionId, takeBackConversation } from './background.js';
import { nativeRecoveryArgs } from './native-recovery.js';

const CHANNEL_FLAGS = ['--dangerously-load-development-channels', 'server:metro'];
const FRESH_PROMPT_FLAGS = ['--system-prompt-snapshot', 'off'];
export const PERMISSION_MODE_FLAG: Record<PermissionMode, string> = { auto: 'auto', bypass: 'bypassPermissions' };
const KEY_HEADER = 'x-metro-key';
const PROBE_MS = 3_000;
const AUTH_STATUS_MS = 20_000;
const KILL_GRACE_MS = 30_000;

export const claudeArgs = (extra: string[], mcpConfig?: string, mode: PermissionMode = 'auto', prompt: string | null = null): string[] => [
  ...CHANNEL_FLAGS,
  '--permission-mode',
  PERMISSION_MODE_FLAG[mode],
  ...FRESH_PROMPT_FLAGS,
  ...(mcpConfig === undefined ? [] : ['--mcp-config', mcpConfig]),
  ...(prompt === null ? [] : ['--append-system-prompt', prompt]),
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

export const channelEnv = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv =>
  set(env, 'MCP_PROTOCOL_NEGOTIATION') ? env : { ...env, MCP_PROTOCOL_NEGOTIATION: 'legacy' };

export const toolSearchEnv = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv =>
  set(env, 'ENABLE_TOOL_SEARCH') ? env : { ...env, ENABLE_TOOL_SEARCH: 'true' };

const RM_PROMPT_OFF = 'CLAUDE_CODE_DISABLE_INLINE_SHELL_RM_PROMPT';

export const rmPromptEnv = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv =>
  set(env, RM_PROMPT_OFF) ? env : { ...env, [RM_PROMPT_OFF]: '1' };

const OWN_CREDENTIALS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];

export function credentialEnv(env: NodeJS.ProcessEnv, agentKey: string, signedIn: boolean): NodeJS.ProcessEnv {
  if (signedIn || OWN_CREDENTIALS.some((name) => set(env, name))) return env;
  return { ...env, ANTHROPIC_AUTH_TOKEN: agentKey };
}

function claudeSignedIn(): boolean {
  const run = spawnSync('claude', ['auth', 'status', '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: AUTH_STATUS_MS });
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

export function agentKey(agent: LocalAgent | null): Verdict {
  return agent === null ? { skip: 'no agent lives on this machine yet, so Claude Code talks to Anthropic directly' } : { key: agent.key };
}

async function verdict(): Promise<Verdict> {
  const pinned = pinnedBy(process.env);
  if (pinned !== null) return { skip: `${pinned} is set, so Claude Code keeps talking to it` };
  const conflicts = settingsConflicts(settingsFiles());
  if (conflicts.length > 0) return { skip: `a settings file pins the provider (${conflicts.join(', ')}), so Claude Code keeps it` };
  const picked = agentKey(localAgent());
  if ('skip' in picked) return picked;
  if (await daemonServing()) return picked;
  return { skip: 'the daemon is not serving here (stopped, or not running), so Claude Code talks to Anthropic directly' };
}

function deadline(child: ChildProcess, timeoutMs: number | undefined): () => void {
  if (timeoutMs === undefined) return () => undefined;
  let kill: NodeJS.Timeout | undefined;
  const term = setTimeout(() => {
    child.kill('SIGTERM');
    kill = setTimeout(() => {
      child.kill('SIGKILL');
    }, KILL_GRACE_MS);
  }, timeoutMs);
  return () => {
    clearTimeout(term);
    clearTimeout(kill);
  };
}

export function runClaude(args: string[], env: NodeJS.ProcessEnv, headless?: { timeoutMs: number }, command = 'claude'): Promise<number> {
  return new Promise((resolve, reject) => {
    const leaveToChild = (): undefined => undefined;
    process.on('SIGINT', leaveToChild);
    process.on('SIGTERM', leaveToChild);
    const child = spawn(command, args, { stdio: [headless === undefined ? 'inherit' : 'ignore', 'inherit', 'inherit'], env });
    const stop = deadline(child, headless?.timeoutMs);
    child.on('error', (err: NodeJS.ErrnoException) => {
      reject(
        new Error(
          err.code === 'ENOENT'
            ? `the \`${command}\` command is not on PATH${command === 'claude' ? ' — install Claude Code first' : ''}`
            : err.message,
        ),
      );
    });
    child.on('exit', (code) => {
      stop();
      resolve(code ?? 1);
    });
  });
}

async function servedKey(decision: Verdict): Promise<string | null> {
  if ('key' in decision) return decision.key;
  const picked = agentKey(localAgent());
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
  const pointed = routeModelEnv(gatewayEnv(process.env, key, port), currentRoute());
  const routed = toolSearchEnv(pointed);
  if (routed !== pointed) process.stderr.write('metro claude: MCP tool search is on, so connector tools load when Claude needs them instead of all at start\n');
  const env = credentialEnv(routed, key, claudeSignedIn());
  if (env !== routed)
    process.stderr.write("metro claude: Claude Code has no login of its own here, so metro's key stands in as its credential; the Model page must route to Bedrock, OpenRouter or Codex\n");
  if (seedChannels() === 'marked')
    process.stderr.write('metro claude: marked Channels as available in Claude Code cached flags, since a box that sends no telemetry never fetches them\n');
  if (markOnboardingDone() === 'marked')
    process.stderr.write("metro claude: skipped Claude Code's first-run setup, since it already has a credential here\n");
  return env;
}

function inferenceEnv(decision: Verdict, port: number): NodeJS.ProcessEnv {
  if ('key' in decision) return gatewayLaunchEnv(decision.key, port);
  process.stderr.write(`metro claude: ${decision.skip}\n`);
  return process.env;
}

export async function headlessEnv(): Promise<NodeJS.ProcessEnv> {
  return keepInSession(rmPromptEnv(inferenceEnv(await verdict(), localPort())));
}

const continues = (args: string[]): boolean => args.includes('-c') || args.includes('--continue');

async function reclaimConversation(extra: string[]): Promise<void> {
  const sessionId = resumeSessionId(extra);
  if (sessionId === undefined && !continues(extra)) return;
  try {
    const note = await takeBackConversation({ sessionId });
    if (note !== null) process.stderr.write(`metro claude: ${note}\n`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`metro claude: could not check for a Claude Code background session holding the conversation (${message})\n`);
  }
}

const SDK_HOLDS_CHAT =
  'the Harness runs this agent as an Agent SDK session (metro agent), which holds the metro chat; a metro claude session would take it away. Switch the Harness runner back to the Claude Code session first, or open the conversation with plain claude --resume <session id>';

export async function launchClaude(extra: string[]): Promise<number> {
  if (harnessRunner() === 'sdk') throw new Error(SDK_HOLDS_CHAT);
  await reclaimConversation(extra);
  const decision = await verdict();
  const port = localPort();
  const mcp = mcpConfigFor(await servedKey(decision), port);
  const mode = permissionMode();
  const prompt = systemPrompt();
  if (prompt !== null) process.stderr.write('metro claude: the system prompt from the Harness page is appended to this session\n');
  try {
    return await runClaude(claudeArgs(nativeRecoveryArgs(extra), mcp?.path, mode, prompt), keepInSession(rmPromptEnv(channelEnv(inferenceEnv(decision, port)))));
  } finally {
    mcp?.cleanup();
  }
}
