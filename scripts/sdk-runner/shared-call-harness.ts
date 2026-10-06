import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { asLine } from '../../packages/core/src/lines.js';
import type { CallRoute, SpeechTarget } from '../../packages/core/src/call.js';
import { publishEvent } from '../../packages/core/src/events.js';
import { setKeyMap } from '../../apps/daemon/src/agents/keys.js';
import { setAgentMap, setAllowlistMap, setApproversMap } from '../../apps/daemon/src/agents/map.js';
import { pendingPrompts } from '../../apps/daemon/src/approvals/pending.js';
import { createMetroMcp } from '../../apps/daemon/src/mcp/index.js';
import { watchPolicySnapshot } from '../../apps/daemon/src/mcp/policy-snapshot.js';
import { setPolicies, type Access } from '../../apps/daemon/src/policy/policy.js';
import { setTrainCallBackend } from '../../apps/daemon/src/stations/train-call.js';
import { endSharedCall, openSharedCall, sharedCalls } from '../../apps/daemon/src/voice/shared.js';
import { SpeechQueue } from '../../apps/daemon/src/voice/speech-queue.js';
import type { Utterance } from '../../apps/daemon/src/voice/speech.js';
import { Activity } from '../../packages/sdk-runner/src/activity.js';
import { startAgent, type AppHooks, type RunningAgent } from '../../packages/sdk-runner/src/app.js';
import { runnerConfig } from '../../packages/sdk-runner/src/config.js';
import { SharedUpstream, listen } from './shared-call-upstream.js';

export const ROOT = process.env.SHARED_CALL_FIXTURE_ROOT ?? '';
assert.ok(ROOT.startsWith('/tmp/metro-shared-call-'), 'Run shared-call.ts to isolate every fixture path');
for (const key of ['HOME', 'METRO_STATE_DIR', 'METRO_AGENTS_DIR', 'CLAUDE_CONFIG_DIR', 'METRO_TRAINS_DIR', 'METRO_RUNTIME_STORE', 'METRO_RUNNER_STORE', 'TMPDIR'])
  assert.ok(process.env[key]?.startsWith(`${ROOT}/`), `Fixture isolation: ${key}`);
assert.equal(process.env.ANTHROPIC_API_KEY, undefined);
assert.equal(process.env.ANTHROPIC_AUTH_TOKEN, undefined);
assert.ok(process.env.PATH?.startsWith(`${ROOT}/bin:`));
assert.equal(readFileSync(join(ROOT, 'bin', 'tmux'), 'utf8'), '#!/bin/sh\nexit 1\n');

export const AGENT = 'fixture0001';
const ACCOUNT = 'fixture0002';
const OTHER_ACCOUNT = 'fixture0003';
const KEY = `mk_${randomUUID()}`;
const OTHER_KEY = `mk_${randomUUID()}`;
export const LINE = `metro://telegram-bot/${ACCOUNT}/111`;
export const ELSEWHERE = `metro://telegram-bot/${ACCOUNT}/222`;
export const OTHER_LINE = `metro://telegram-bot/${OTHER_ACCOUNT}/333`;
export const FROM = `metro://telegram-bot/${ACCOUNT}/user/111`;
export const ALICE = `metro://telegram-bot/${ACCOUNT}/user/222`;
const agentDir = join(ROOT, 'agents');
const claudeDir = join(ROOT, 'claude');
const home = join(ROOT, 'home');
writeFileSync(join(agentDir, 'claude-setup.json'), JSON.stringify({ runner: 'sdk' }));
writeFileSync(join(agentDir, 'agent.json'), JSON.stringify({ version: 1, id: AGENT, key: KEY, stations: [] }));
const guard = fileURLToPath(new URL('../../plugin/bin/guard.mjs', import.meta.url));
writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: `node ${JSON.stringify(guard)}` }] }] } }));
mkdirSync(join(home, '.metro'), { recursive: true });
setKeyMap([{ key: KEY, agentId: AGENT }, { key: OTHER_KEY, agentId: 'other000001' }]);
setAgentMap({ [`telegram-bot/${ACCOUNT}`]: AGENT, [`telegram-bot/${OTHER_ACCOUNT}`]: 'other000001' }, { [AGENT]: 'Fixture owner', other000001: 'Other fixture owner' });
setAllowlistMap({ [`telegram-bot/${ACCOUNT}`]: ['111', '222'], [`telegram-bot/${OTHER_ACCOUNT}`]: ['333'] });
setApproversMap({ [`telegram-bot/${ACCOUNT}`]: ['111'], [`telegram-bot/${OTHER_ACCOUNT}`]: ['333'] });
export const policy = (send: Access): void => {
  setPolicies('channel', [[{ kind: 'channel', station: 'telegram-bot', account: ACCOUNT }, { tools: { send } }]]);
};
policy('allow');
watchPolicySnapshot();
export const delays = { write: 0, speech: 0 };
export const train: { action: string; args: Record<string, unknown>; at: number; completedAt: number | null }[] = [];
setTrainCallBackend(async (_name, action, args) => {
  const call = { action, args: args as Record<string, unknown>, at: Date.now(), completedAt: null as number | null };
  train.push(call);
  const id = train.length;
  if (delays.write > 0) await Bun.sleep(delays.write);
  call.completedAt = Date.now();
  return { result: { messageId: `fixture-out-${id}` } };
});
export const upstream = new SharedUpstream();
await upstream.start();
export const mcp = await createMetroMcp();
mcp.startInbound();
let mcpSession = '';
let holdingGets = false;
export const gets = new Set<ServerResponse>();
export const heldGets = new Map<ServerResponse, () => void>();
function handle(req: IncomingMessage, res: ServerResponse): void {
  if (req.method === 'GET' && req.headers.authorization === `Bearer ${KEY}`) {
    if (holdingGets) {
      heldGets.set(res, () => { handle(req, res); });
      res.on('close', () => { heldGets.delete(res); });
      return;
    }
    gets.add(res);
    res.on('close', () => { gets.delete(res); });
  }
  if (typeof req.headers['mcp-session-id'] === 'string' && req.headers.authorization === `Bearer ${KEY}`)
    mcpSession = req.headers['mcp-session-id'];
  mcp.httpHandler(req, res).catch((err: unknown) => {
    process.stderr.write(`Fixture MCP failure: ${String(err)}\n`);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  });
}
const http = createServer(handle);
export function detachGet(): () => void {
  assert.ok(gets.size > 0);
  holdingGets = true;
  for (const res of gets) res.destroy();
  return () => {
    holdingGets = false;
    for (const resume of heldGets.values()) resume();
    heldGets.clear();
  };
}
export const base = await listen(http);
const cfg = runnerConfig({
  ...process.env, METRO_RUNNER_MCP_URL: `${base}/mcp`, METRO_AGENT_KEY: KEY,
  METRO_RUNNER_MODEL: 'claude-opus-5-5', METRO_RUNNER_STATE: join(ROOT, 'session.json'), METRO_RUNNER_PERMISSION_MODE: 'bypass',
}, home);
const env = { ...process.env, ANTHROPIC_BASE_URL: upstream.base, ANTHROPIC_API_KEY: 'fixture-not-a-live-key', ENABLE_TOOL_SEARCH: 'false' };
export const events: Record<string, unknown>[] = [];
export const timedEvents: { at: number; message: Record<string, unknown> }[] = [];
export const snapshots: ReturnType<Activity['snapshot']>[] = [];
let failure: unknown;
export let activity = new Activity(join(home, '.metro', 'agent-status.json'));
export let agent: RunningAgent;
const observe: NonNullable<AppHooks['observe']> = (message) => {
  const observed = { ...message };
  events.push(observed);
  timedEvents.push({ at: Date.now(), message: observed });
  snapshots.push(activity.snapshot());
};

export async function boot(compactAt = 10_000_000, waitIdle = true): Promise<void> {
  failure = undefined;
  activity = new Activity(join(home, '.metro', 'agent-status.json'));
  agent = await startAgent(cfg, {
    activity, env, compactAt, observe,
    lost: (reason) => { failure = new Error(reason); },
  });
  agent.done.catch((err: unknown) => { failure = err; });
  if (waitIdle) await until('SDK initialized', () => activity.snapshot().mainPhase === 'idle');
}

export async function until(label: string, check: () => boolean, timeout = 30_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (failure !== undefined) throw failure;
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}; activity=${JSON.stringify(activity.snapshot())}; upstream=${upstream.seen.map((r) => r.text.slice(0, 100)).join('|')}`);
    await Bun.sleep(20);
  }
}

export async function idle(): Promise<void> {
  await until('main idle with empty input queue', () => activity.snapshot().mainPhase === 'idle' && activity.snapshot().pending === 0);
  await Bun.sleep(80);
}

export const report = (check: string, data: Record<string, unknown> = {}): void => {
  process.stdout.write(`${JSON.stringify({ check, ...data })}\n`);
};

export function chat(text: string, line = LINE, from = FROM, extra: Record<string, unknown> = {}): string {
  const messageId = `fixture-in-${randomUUID()}`;
  publishEvent({ id: randomUUID(), ts: new Date().toISOString(), station: 'telegram-bot', line: asLine(line), from: asLine(from), to: asLine(line),
    messageId, text, event: { type: 'msg' }, isPrivate: true, senderVerified: true, ...extra });
  return messageId;
}

export const sent = (text: string): number => train.filter((call) => call.action === 'send' && call.args.text === text).length;
export const target = (route: CallRoute, sourceId: string): SpeechTarget => ({ callId: route.callId, generation: route.generation, sourceId });
export const pending = pendingPrompts;

export interface FakeCall {
  route: CallRoute;
  sourceId: string;
  queue: SpeechQueue;
  synthesized: string[];
  frames: number[];
  synthesis: { at: number; text: string }[];
  audio: { at: number; text: string }[];
  end(): void;
}
export const opened: FakeCall[] = [];
export async function call(callId: string = randomUUID(), waitIdle = true): Promise<FakeCall> {
  const route = { agentId: AGENT, line: LINE, from: FROM, callId, generation: randomUUID() };
  const sourceId = randomUUID();
  const synthesized: string[] = [];
  const frames: number[] = [];
  const synthesis: FakeCall['synthesis'] = [];
  const audio: FakeCall['audio'] = [];
  let playingText = '';
  const queue = new SpeechQueue({ provider: 'elevenlabs', apiKey: 'fixture', voiceId: 'fixture', model: 'fixture', language: 'en', enabled: true }, (_opus, timestamp, marker) => {
    if (marker) { frames.push(timestamp); audio.push({ at: Date.now(), text: playingText }); }
  }, () => {
    let output: Parameters<Utterance['attach']>[0] | undefined;
    let text = '';
    let timer: ReturnType<typeof setTimeout> | undefined;
    const emit = (): void => { synthesized.push(text); output?.audio(new Int16Array(960).fill(1000), text.length); output?.done(); };
    return {
      attach: (value) => { output = value; }, say: (value) => { text += value; },
      end: () => {
        playingText = text;
        synthesis.push({ at: Date.now(), text });
        if (delays.speech > 0) timer = setTimeout(emit, delays.speech);
        else emit();
      },
      abort: () => { if (timer !== undefined) clearTimeout(timer); },
    };
  });
  const fake: FakeCall = { route, sourceId, synthesized, frames, synthesis, audio, queue, end: () => { endSharedCall(route); } };
  assert.equal(openSharedCall(route, sourceId, { enqueue: (action) => queue.enqueue(action), terminate: () => queue.close() }), true, 'Real MCP bridge accepted the exact authorized call');
  opened.push(fake);
  queue.connect();
  await until('call started notice', () => activity.snapshot().callState === 'started');
  if (waitIdle) await idle();
  return fake;
}

export async function rawSend(input: Record<string, unknown>, otherOwner = false): Promise<Record<string, unknown>> {
  const res = await fetch(`${base}/mcp`, {
    method: 'POST', headers: { authorization: `Bearer ${otherOwner ? OTHER_KEY : KEY}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json', 'mcp-session-id': mcpSession },
    body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method: 'tools/call', params: { name: 'send', arguments: input } }),
  });
  const raw = await res.text();
  assert.equal(res.status, 200, raw);
  const payload: unknown = JSON.parse(raw.startsWith('event:') || raw.startsWith('id:') ? raw.split('\n').find((line) => line.startsWith('data: '))?.slice(6) ?? '' : raw);
  assert.ok(typeof payload === 'object' && payload !== null);
  return payload as Record<string, unknown>;
}

export function rawGet(signal: AbortSignal, cursor?: string): Promise<Response> {
  return fetch(`${base}/mcp`, {
    headers: { authorization: `Bearer ${KEY}`, accept: 'text/event-stream', 'mcp-session-id': mcpSession, ...(cursor === undefined ? {} : { 'last-event-id': cursor }) },
    signal,
  });
}

export async function authProof(): Promise<void> {
  assert.equal((await fetch(`${base}/mcp`)).status, 401);
  assert.equal((await fetch(`${base}/mcp`, { headers: { authorization: 'Bearer wrong-fixture-key' } })).status, 401);
  assert.equal((await fetch(`${base}/mcp`, { headers: { authorization: `Bearer ${KEY}`, 'x-forwarded-host': 'fixture.invalid', 'x-forwarded-for': '192.0.2.1' } })).status, 401);
  report('authenticated HTTP bridge', { missingKey: 401, wrongKey: 401, proxiedKey: 401 });
}

export async function close(): Promise<void> {
  for (const fake of opened) fake.end();
  sharedCalls.disconnect();
  await agent?.stop();
  await agent?.done.catch((err: unknown) => { process.stderr.write(`SDK stopped: ${String(err)}\n`); });
  http.closeAllConnections();
  http.close();
  upstream.close();
}
