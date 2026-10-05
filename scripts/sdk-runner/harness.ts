import { copyFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { SDKMessage } from '../../packages/sdk-runner/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs';
import type { Activity } from '../../packages/sdk-runner/src/activity.ts';
import { startStandIn, STANDIN_KEY, type StandIn } from './key-route.ts';
import { startScripted, type ScriptedUpstream } from './scripted-upstream.ts';

const ROOT = mkdtempSync(join(tmpdir(), 'sdk-runner-check-'));
export const AGENTS = join(ROOT, 'agents');
export const CLAUDE_DIR = join(ROOT, 'claude');
export const WORK = join(ROOT, 'work');
mkdirSync(AGENTS, { recursive: true });
mkdirSync(WORK, { recursive: true });
mkdirSync(CLAUDE_DIR, { recursive: true });
const realAgentFile = join(process.env.METRO_AGENTS_DIR ?? join(homedir(), '.metro', 'agents'), 'agent.json');
if (existsSync(realAgentFile)) copyFileSync(realAgentFile, join(AGENTS, 'agent.json'));
process.env.METRO_AGENTS_DIR = AGENTS;
process.env.METRO_LOG_LEVEL ??= 'warn';

const { publishEvent } = await import('../../packages/core/src/events.ts');
const { createMetroMcp } = await import('../../apps/daemon/src/mcp/index.ts');
const { setKeyMap } = await import('../../apps/daemon/src/agents/keys.ts');
const { setAgentMap, setAllowlistMap, setApproversMap } = await import('../../apps/daemon/src/agents/map.ts');
const { setTrainCallBackend } = await import('../../apps/daemon/src/stations/train-call.ts');
const { setPolicies } = await import('../../apps/daemon/src/policy/policy.ts');
const { watchPolicySnapshot } = await import('../../apps/daemon/src/mcp/policy-snapshot.ts');
const { handleGatewayRequest } = await import('../../apps/daemon/src/gateway/gateway.ts');
const { readModelConfig } = await import('../../apps/daemon/src/gateway/model-config.ts');
const { startAgent } = await import('../../packages/sdk-runner/src/app.ts');
const { runnerConfig } = await import('../../packages/sdk-runner/src/config.ts');

const T0 = performance.now();
export const now = (): number => Math.round(performance.now() - T0);
export const say = (kind: string, data: Record<string, unknown> = {}): void => {
  process.stdout.write(`${JSON.stringify({ t: now(), kind, ...data })}\n`);
};

const AGENT = 'agent000001';
const KEY = `mk_${randomUUID()}`;
const TG = 'tb000000001';
const TG2 = 'tb000000002';
export const LINE = `metro://telegram-bot/${TG}/-100777`;
export const OTHER = `metro://telegram-bot/${TG2}/-100999`;
export const GROUP = `metro://telegram-bot/${TG}/-100888`;
export const LESS = `metro://telegram-bot/${TG}/user/111`;
export const ALICE = `metro://telegram-bot/${TG}/user/222`;
export const BOB = `metro://telegram-bot/${TG}/user/333`;
const PORT = Number(process.env.SDK_RUNNER_CHECK_PORT ?? 18419);
const NAMES: Record<string, string> = { [LESS]: 'Less', [ALICE]: 'Alice', [BOB]: 'Bob' };

setKeyMap([{ key: KEY, agentId: AGENT }]);
setAgentMap({ [`telegram-bot/${TG}`]: AGENT, [`telegram-bot/${TG2}`]: AGENT }, { [AGENT]: 'Emma' });
setAllowlistMap({ [`telegram-bot/${TG}`]: ['111', '222', '333'], [`telegram-bot/${TG2}`]: ['111'] });
setApproversMap({ [`telegram-bot/${TG}`]: ['111'] });
setPolicies('channel', [[{ kind: 'channel', station: 'telegram-bot', account: TG2 }, { tools: { send: 'ask' } }]]);
watchPolicySnapshot();

export interface Call {
  t: number;
  action: string;
  args: Record<string, unknown>;
}
export const calls: Call[] = [];
setTrainCallBackend((_train, action, args) => {
  const a = args as Record<string, unknown>;
  calls.push({ t: now(), action, args: a });
  say('train', { action, line: a.line, text: typeof a.text === 'string' ? a.text.slice(0, 160) : undefined, emoji: a.emoji });
  return Promise.resolve({ result: { messageId: `out-${String(calls.length)}` } });
});

const keyRoute = process.env.SDK_RUNNER_CHECK_ROUTE === 'key';
const scriptedRoute = process.env.SDK_RUNNER_CHECK_ROUTE === 'scripted';
const gatewayOn = keyRoute || scriptedRoute;
export const standIn: StandIn | null = keyRoute ? await startStandIn(PORT + 1) : null;
export const upstream: ScriptedUpstream | null = scriptedRoute ? await startScripted(PORT + 1) : null;
if (keyRoute) {
  writeFileSync(
    join(AGENTS, 'model.json'),
    JSON.stringify({ version: 2, route: 'keyed', connections: [{ id: 'keyed', provider: 'anthropic', label: 'Anthropic', model: '', apiKey: STANDIN_KEY, region: '', zdr: false }] }),
  );
}

export const mcp = await createMetroMcp();
mcp.startInbound();
export const UPSTREAM = `http://127.0.0.1:${String(PORT + 1)}`;
const gateway = { config: () => readModelConfig(AGENTS), identify: (key: string) => key === KEY, anthropicBase: UPSTREAM, openrouterBase: UPSTREAM };
let also: ((req: IncomingMessage, res: ServerResponse) => boolean) | null = null;
export const serveAlso = (handler: (req: IncomingMessage, res: ServerResponse) => boolean): void => {
  also = handler;
};
export const BASE = `http://127.0.0.1:${String(PORT)}`;
const http = createServer((req: IncomingMessage, res: ServerResponse) => {
  if (also?.(req, res) === true) return;
  if (gatewayOn && handleGatewayRequest(req, res, gateway)) return;
  mcp.httpHandler(req, res).catch(() => undefined);
});
await new Promise<void>((resolve) => http.listen(PORT, '127.0.0.1', () => resolve()));

let seq = 0;
export function chat(from: string, text: string, line = LINE, extra: Record<string, unknown> = {}): string {
  seq += 1;
  const id = `in-${String(seq)}`;
  publishEvent({
    id: `ev-${randomUUID()}`,
    ts: new Date().toISOString(),
    station: 'telegram-bot',
    line,
    from,
    to: line,
    text,
    messageId: id,
    fromName: NAMES[from] ?? 'Someone',
    event: { type: 'msg' },
    isPrivate: line !== GROUP,
    ...extra,
  } as never);
  say('chat_in', { id, from: (NAMES[from] ?? 'someone').toLowerCase(), chars: text.length, text: text.slice(0, 80) });
  return id;
}

const DROP = /^(CLAUDECODE|CLAUDE_CODE_CHILD_SESSION|CLAUDE_CODE_MESSAGING_SOCKET|CLAUDE_CODE_MESSAGING_TOKEN|CLAUDE_CODE_SESSION_ID|CLAUDE_PID|CLAUDE_CODE_SESSION_ATTENDED|CLAUDE_CODE_ENTRYPOINT|CLAUDE_CODE_EXECPATH|CLAUDE_EFFORT)$/;
const inherited: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !DROP.test(k)));
const throughGateway: NodeJS.ProcessEnv = gatewayOn ? { ...inherited, ANTHROPIC_BASE_URL: `${BASE}/gateway`, ANTHROPIC_CUSTOM_HEADERS: `x-metro-key: ${KEY}\nx-metro-runner: sdk` } : inherited;
const childEnv: NodeJS.ProcessEnv = scriptedRoute ? { ...throughGateway, CLAUDE_CONFIG_DIR: CLAUDE_DIR, ANTHROPIC_AUTH_TOKEN: KEY } : throughGateway;

const cfg = runnerConfig(
  {
    ...childEnv,
    METRO_RUNNER_MCP_URL: `${BASE}/mcp`,
    METRO_AGENT_KEY: KEY,
    METRO_RUNNER_STATE: join(ROOT, 'session.json'),
    METRO_RUNNER_PERMISSION_MODE: 'bypass',
    METRO_RUNNER_MODEL: process.env.SDK_RUNNER_CHECK_MODEL ?? 'claude-sonnet-5-5',
  },
  WORK,
);

export interface Turn {
  t: number;
  kind: string;
  data: Record<string, unknown>;
}
export const events: Turn[] = [];
export const spoken: { t: number; text: string }[] = [];
export const stalls: number[] = [];
const firstWords: number[] = [];
export const wordsAfter = (at: number): number => (firstWords.find((t) => t >= at) ?? at) - at;
let speaking = '';
const record = (m: SDKMessage): void => {
  const r: Record<string, unknown> = { ...m };
  if (r.type === 'system' && r.subtype === 'init') events.push({ t: now(), kind: 'init', data: { session: r.session_id, claude: r.claude_code_version } });
  if (r.type === 'result') {
    events.push({ t: now(), kind: 'result', data: { ms: r.duration_ms, cost: r.total_cost_usd, usage: r.usage, models: r.modelUsage, uuids: r.user_message_uuids, origin: r.origin } });
    say('result', { ms: r.duration_ms, cost: r.total_cost_usd, text: typeof r.result === 'string' ? r.result.slice(0, 120) : '' });
  }
  if (r.type === 'assistant' && r.parent_tool_use_id === null) events.push({ t: now(), kind: 'assistant', data: { usage: (r.message as Record<string, unknown> | undefined)?.usage } });
  if (r.type === 'system' && typeof r.subtype === 'string' && /^(task_started|task_notification|compact_boundary|status)$/.test(r.subtype)) {
    events.push({ t: now(), kind: r.subtype, data: { status: r.status, task: r.task_id, meta: r.compact_metadata } });
    say(r.subtype, { status: r.status, meta: r.compact_metadata });
  }
  if (r.type === 'stream_event' && r.parent_tool_use_id === null) {
    const e = r.event as Record<string, unknown>;
    const block = e.content_block as Record<string, unknown> | undefined;
    if (e.type === 'content_block_start' && block?.type === 'tool_use') say('tool', { name: block.name });
  }
};

let lostReason: string | null = null;
export const lost = (): string | null => lostReason;
export const boot = (compactAt: number, activity?: Activity): ReturnType<typeof startAgent> =>
  startAgent(cfg, {
    activity,
    speech: {
      say: (text) => {
        if (speaking === '') {
          firstWords.push(now());
          say('first_words');
        }
        speaking += text;
      },
      stalled: () => {
        say('stalled');
        stalls.push(now());
      },
      done: () => {
        spoken.push({ t: now(), text: speaking.trim() });
        say('spoken', { text: speaking.trim().slice(0, 200) });
        speaking = '';
      },
    },
    lost: (reason) => {
      lostReason = reason;
    },
    observe: record,
    env: childEnv,
    compactAt,
  });

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
export async function until(what: string, pred: () => boolean, ms = 120_000): Promise<number> {
  const start = now();
  while (!pred()) {
    if (now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
  return now() - start;
}
export const sendsOn = (line: string, after: number): Call[] => calls.filter((c) => c.t >= after && (c.action === 'send' || c.action === 'reply') && c.args.line === line);
export const reactsTo = (id: string): Call[] => calls.filter((c) => c.action === 'react' && JSON.stringify(c.args).includes(`"${id}"`));
export const turnsSince = (after: number): number => events.filter((e) => e.t >= after && e.kind === 'result').length;
const workersBusy = (): boolean => events.some((e) => e.kind === 'task_started' && !events.some((d) => d.kind === 'task_notification' && d.t > e.t && d.data.task === e.data.task));
export async function settled(quietMs = 3_000, waitWorkers = true): Promise<void> {
  await until(
    'the session to settle',
    () => {
      const last = events[events.length - 1];
      return (last === undefined || (last.kind !== 'init' && now() - last.t > quietMs)) && (!waitWorkers || !workersBusy());
    },
    300_000,
  ).catch(() => 0);
}

export function close(): void {
  http.close();
  standIn?.close();
  upstream?.close();
}
