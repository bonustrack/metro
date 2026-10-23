import { spawnSync } from 'node:child_process';
import { currentRoute, routeModelEnv } from './route.js';
import { settingsConflicts, settingsFiles } from './claude-settings.js';
import { localAgent, type LocalAgent } from './local.js';
import { PROVIDER_FLAGS } from './provider-flags.js';
import { localPort, localUrl } from './runtime.js';

const KEY_HEADER = 'x-metro-key';
const PROBE_MS = 3_000;
const AUTH_STATUS_MS = 20_000;
const RM_PROMPT_OFF = 'CLAUDE_CODE_DISABLE_INLINE_SHELL_RM_PROMPT';
const OWN_CREDENTIALS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];
const CACHE_TTLS = ['CLAUDE_CODE_PROMPT_CACHE_TTL', 'CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL'];
const LONG_CACHE = '1h';

export const AGENT_VIEW_OFF = 'CLAUDE_CODE_DISABLE_AGENT_VIEW';
export const NO_UPDATES = { DISABLE_AUTOUPDATER: '1' } as const;

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

export const toolSearchEnv = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv =>
  set(env, 'ENABLE_TOOL_SEARCH') ? env : { ...env, ENABLE_TOOL_SEARCH: 'true' };

export function cacheTtlEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const missing = CACHE_TTLS.filter((name) => !set(env, name));
  return missing.length === 0 ? env : { ...env, ...Object.fromEntries(missing.map((name) => [name, LONG_CACHE])) };
}

export const rmPromptEnv = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv =>
  set(env, RM_PROMPT_OFF) ? env : { ...env, [RM_PROMPT_OFF]: '1' };

export const keepInSession = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv =>
  set(env, AGENT_VIEW_OFF) ? env : { ...env, [AGENT_VIEW_OFF]: '1' };

export function credentialEnv(env: NodeJS.ProcessEnv, agentKey: string, signedIn: boolean): NodeJS.ProcessEnv {
  if (signedIn || OWN_CREDENTIALS.some((name) => set(env, name))) return env;
  return { ...env, ANTHROPIC_AUTH_TOKEN: agentKey };
}

export function claudeSignedIn(claude: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const run = spawnSync(claude, ['auth', 'status', '--json'], { encoding: 'utf8', env: { ...env, ...NO_UPDATES }, stdio: ['ignore', 'pipe', 'ignore'], timeout: AUTH_STATUS_MS });
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

function gatewayLaunchEnv(key: string, port: number, claude: string, say: (line: string) => void): NodeJS.ProcessEnv {
  say(`inference goes through the daemon at http://127.0.0.1:${String(port)}/gateway (the Model page decides where)`);
  const pointed = routeModelEnv(gatewayEnv(process.env, key, port), currentRoute());
  const searched = toolSearchEnv(pointed);
  if (searched !== pointed) say('MCP tool search is on, so connector tools load when Claude needs them instead of all at start');
  const routed = cacheTtlEnv(searched);
  const env = credentialEnv(routed, key, claudeSignedIn(claude));
  if (env !== routed) say("Claude Code has no login of its own here, so metro's key stands in as its credential; the organization's Models page decides where requests go");
  return env;
}

export async function headlessEnv(claude: string, command: string): Promise<NodeJS.ProcessEnv> {
  const say = (line: string): void => {
    process.stderr.write(`${command}: ${line}\n`);
  };
  const decision = await verdict();
  if ('skip' in decision) say(decision.skip);
  const env = 'key' in decision ? gatewayLaunchEnv(decision.key, localPort(), claude, say) : process.env;
  return { ...keepInSession(rmPromptEnv(env)), ...NO_UPDATES };
}
