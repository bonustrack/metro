import { copyFileSync, existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { SDKMessage } from '../../packages/sdk-runner/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs';

const ROOT = mkdtempSync(join(tmpdir(), 'sdk-runner-check-'));
const AGENTS = join(ROOT, 'agents');
const WORK = join(ROOT, 'work');
mkdirSync(AGENTS, { recursive: true });
mkdirSync(WORK, { recursive: true });
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
const { startAgent } = await import('../../packages/sdk-runner/src/app.ts');
const { runnerConfig } = await import('../../packages/sdk-runner/src/config.ts');

const T0 = performance.now();
const now = (): number => Math.round(performance.now() - T0);
const say = (kind: string, data: Record<string, unknown> = {}): void => {
  process.stdout.write(`${JSON.stringify({ t: now(), kind, ...data })}\n`);
};

const AGENT = 'agent000001';
const KEY = `mk_${randomUUID()}`;
const TG = 'tb000000001';
const TG2 = 'tb000000002';
const LINE = `metro://telegram-bot/${TG}/-100777`;
const OTHER = `metro://telegram-bot/${TG2}/-100999`;
const LESS = `metro://telegram-bot/${TG}/user/111`;
const ALICE = `metro://telegram-bot/${TG}/user/222`;
const PORT = Number(process.env.SDK_RUNNER_CHECK_PORT ?? 18419);

setKeyMap([{ key: KEY, agentId: AGENT }]);
setAgentMap({ [`telegram-bot/${TG}`]: AGENT, [`telegram-bot/${TG2}`]: AGENT }, { [AGENT]: 'Emma' });
setAllowlistMap({ [`telegram-bot/${TG}`]: ['111', '222'], [`telegram-bot/${TG2}`]: ['111'] });
setApproversMap({ [`telegram-bot/${TG}`]: ['111'] });
setPolicies('channel', [[{ kind: 'channel', station: 'telegram-bot', account: TG2 }, { tools: { send: 'ask' } }]]);
watchPolicySnapshot();

interface Call {
  t: number;
  action: string;
  args: Record<string, unknown>;
}
const calls: Call[] = [];
setTrainCallBackend((_train, action, args) => {
  const a = args as Record<string, unknown>;
  calls.push({ t: now(), action, args: a });
  say('train', { action, line: a.line, text: typeof a.text === 'string' ? a.text.slice(0, 160) : undefined, emoji: a.emoji });
  return Promise.resolve({ result: { messageId: `out-${String(calls.length)}` } });
});

const mcp = await createMetroMcp();
mcp.startInbound();
const http = createServer((req, res) => {
  mcp.httpHandler(req, res).catch(() => undefined);
});
await new Promise<void>((resolve) => http.listen(PORT, '127.0.0.1', () => resolve()));

let seq = 0;
function chat(from: string, text: string, line = LINE): string {
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
    fromName: from === LESS ? 'Less' : 'Alice',
    event: { type: 'msg' },
    isPrivate: true,
  } as never);
  say('chat_in', { id, from: from === LESS ? 'less' : 'alice', text: text.slice(0, 120) });
  return id;
}

const DROP = /^(CLAUDECODE|CLAUDE_CODE_CHILD_SESSION|CLAUDE_CODE_MESSAGING_SOCKET|CLAUDE_CODE_MESSAGING_TOKEN|CLAUDE_CODE_SESSION_ID|CLAUDE_PID|CLAUDE_CODE_SESSION_ATTENDED|CLAUDE_CODE_ENTRYPOINT|CLAUDE_CODE_EXECPATH|CLAUDE_EFFORT)$/;
const childEnv: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !DROP.test(k)));

const cfg = runnerConfig(
  { ...childEnv, METRO_RUNNER_MCP_URL: `http://127.0.0.1:${String(PORT)}/mcp`, METRO_AGENT_KEY: KEY, METRO_RUNNER_STATE: join(ROOT, 'session.json'), METRO_RUNNER_PERMISSION_MODE: 'bypass' },
  WORK,
);

interface Turn {
  t: number;
  kind: string;
  data: Record<string, unknown>;
}
const events: Turn[] = [];
const spoken: { t: number; text: string }[] = [];
const stalls: number[] = [];
const firstWords: number[] = [];
const wordsAfter = (at: number): number => (firstWords.find((t) => t >= at) ?? at) - at;
let speaking = '';
const record = (m: SDKMessage): void => {
  const r: Record<string, unknown> = { ...m };
  if (r.type === 'system' && r.subtype === 'init') events.push({ t: now(), kind: 'init', data: { session: r.session_id } });
  if (r.type === 'result') {
    events.push({ t: now(), kind: 'result', data: { ms: r.duration_ms, cost: r.total_cost_usd, uuids: r.user_message_uuids, origin: r.origin } });
    say('result', { ms: r.duration_ms, cost: r.total_cost_usd, text: typeof r.result === 'string' ? r.result.slice(0, 200) : '' });
  }
  if (r.type === 'system' && typeof r.subtype === 'string' && /^(task_started|task_notification|compact_boundary|status)$/.test(r.subtype)) {
    events.push({ t: now(), kind: r.subtype, data: { status: r.status, task: r.task_id, meta: r.compact_metadata } });
    say(r.subtype, { status: r.status, meta: r.compact_metadata });
  }
  if (r.type === 'user' && r.isReplay === true) say('replay', { uuid: r.uuid });
  if (r.type === 'stream_event' && r.parent_tool_use_id === null) {
    const e = r.event as Record<string, unknown>;
    const block = e.content_block as Record<string, unknown> | undefined;
    if (e.type === 'content_block_start' && block?.type === 'tool_use') say('tool', { name: block.name });
  }
};

let lostReason: string | null = null;
const boot = (): ReturnType<typeof startAgent> =>
  startAgent(cfg, {
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
    compactAt: Number(process.env.SDK_RUNNER_CHECK_COMPACT_AT ?? 100_000),
  });

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function until(what: string, pred: () => boolean, ms = 120_000): Promise<number> {
  const start = now();
  while (!pred()) {
    if (now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
  return now() - start;
}
const sendsOn = (line: string, after: number): Call[] => calls.filter((c) => c.t >= after && (c.action === 'send' || c.action === 'reply') && c.args.line === line);
const reactsTo = (id: string): Call[] => calls.filter((c) => c.action === 'react' && JSON.stringify(c.args).includes(`"${id}"`));
const results = (after: number): Turn[] => events.filter((e) => e.t >= after && e.kind === 'result');
const numbers: Record<string, unknown> = {};

const turnsSince = (after: number): number => events.filter((e) => e.t >= after && e.kind === 'result').length;
async function settled(quietMs = 3_000): Promise<void> {
  await until('the session to settle', () => {
    const last = events[events.length - 1];
    return (last === undefined || (last.kind !== 'init' && now() - last.t > quietMs)) && !events.some((e) => e.kind === 'task_started' && !events.some((d) => d.kind === 'task_notification' && d.t > e.t));
  }, 300_000).catch(() => 0);
}
const ONLY = (process.env.SDK_RUNNER_CHECK_STEPS ?? '').split(',').filter((n) => n !== '');
const step = async (name: string, body: () => Promise<void>): Promise<void> => {
  if (ONLY.length > 0 && !ONLY.includes(name)) return;
  if (name !== 'call_cuts_chat_turn' && name !== 'chat_during_call' && name !== 'worker_during_call' && name !== 'call_end') await settled();
  else await settled(1_500);
  say('step', { name });
  try {
    await body();
  } catch (err) {
    numbers[`${name}_error`] = err instanceof Error ? err.message : String(err);
    say('step_failed', { name, err: numbers[`${name}_error`] });
  }
};

let agent = await boot();

await step('chat', async () => {
  const at = now();
  const id = chat(LESS, 'Hi Emma, what is 6 times 7? Answer here in one line.');
  numbers.chat_first_react_ms = await until('react', () => reactsTo(id).length > 0);
  await until('send', () => sendsOn(LINE, at).length > 0);
  numbers.chat_answer_ms = (sendsOn(LINE, at)[0]?.t ?? 0) - at;
  numbers.chat_answer = sendsOn(LINE, at)[0]?.args.text;
  await until('turn end', () => turnsSince(at) > 0);
});

await step('delegate', async () => {
  const at = now();
  chat(LESS, 'Please count the TypeScript lines in each folder under /home/agent/ws-metro-119/metro/packages/core/src (wc -l is fine) and report the total here.');
  numbers.delegate_task_started_ms = await until('task started', () => events.some((e) => e.t >= at && e.kind === 'task_started'));
  numbers.delegate_react_ms = await until('react', () => calls.some((c) => c.t >= at && c.action === 'react'));
  await until('worker done', () => events.some((e) => e.t >= at && e.kind === 'task_notification'), 300_000);
  const done = events.find((e) => e.t >= at && e.kind === 'task_notification')?.t ?? 0;
  numbers.delegate_worker_ms = done - at;
  await until('result relayed', () => sendsOn(LINE, done).length > 0);
  numbers.delegate_relay_after_worker_ms = (sendsOn(LINE, done)[0]?.t ?? 0) - done;
  numbers.delegate_result = sendsOn(LINE, done)[0]?.args.text;
});

await step('approval', async () => {
  const at = now();
  chat(LESS, `Please post exactly "approval check" on the line ${OTHER} with the metro send tool.`);
  await until('prompt', () => calls.some((c) => c.t >= at && c.action === 'send' && String(c.args.text).startsWith('Approval needed')), 180_000);
  const prompt = calls.find((c) => c.t >= at && c.action === 'send' && String(c.args.text).startsWith('Approval needed'));
  numbers.approval_prompt_ms = (prompt?.t ?? 0) - at;
  numbers.approval_prompt_line_ok = prompt?.args.line === LINE;
  const pid = /yes ([a-km-z]{5})/.exec(String(prompt?.args.text))?.[1] ?? '';
  await sleep(1500);
  const yesAt = now();
  chat(LESS, `yes ${pid}`);
  await until('approved send', () => sendsOn(OTHER, yesAt).length > 0, 120_000);
  numbers.approval_send_after_yes_ms = (sendsOn(OTHER, yesAt)[0]?.t ?? 0) - yesAt;
  numbers.approval_sent_text = sendsOn(OTHER, yesAt)[0]?.args.text;
});

await step('call', async () => {
  const at = now();
  agent.runner.callStarted('in your direct chat with Less on telegram-bot, line ' + LINE);
  await until('greeting', () => spoken.some((s) => s.t >= at));
  numbers.call_greeting_first_words_ms = wordsAfter(at);
  const q1 = now();
  agent.runner.heard('Hey Emma, what did the line count find?');
  await until('answer', () => spoken.some((s) => s.t >= q1));
  numbers.call_answer_first_words_ms = wordsAfter(q1);
  numbers.call_answer = spoken.find((s) => s.t >= q1)?.text;
});

await step('chat_during_call', async () => {
  const at = now();
  const before = spoken.length;
  chat(ALICE, 'Hi Emma, quick one: what is 17 times 3?');
  await until('alice answered', () => sendsOn(LINE, at).length > 0);
  await until('turn end', () => turnsSince(at) > 0);
  await sleep(1500);
  numbers.chat_during_call_spoken = spoken.slice(before).map((s) => s.text);
});

await step('call_cuts_chat_turn', async () => {
  const at = now();
  const before = spoken.length;
  const id = chat(LESS, 'Write a 150 word note about why the sky is blue and send it here as one message.');
  await until('chat turn running', () => reactsTo(id).length > 0);
  const cut = now();
  agent.runner.heard('Sorry, quick question: what is the capital of France?');
  await until('speech', () => spoken.slice(before).some((s) => s.t >= cut));
  numbers.cut_first_words_ms = wordsAfter(cut);
  numbers.cut_speech = spoken.slice(before).map((s) => s.text);
  await until('chat note sent', () => sendsOn(LINE, at).some((c) => String(c.args.text).length > 300), 180_000).then(
    (ms) => {
      numbers.cut_chat_completed_ms = ms;
    },
    () => {
      numbers.cut_chat_completed_ms = null;
    },
  );
  numbers.cut_chat_sends = sendsOn(LINE, at).map((c) => String(c.args.text).slice(0, 80));
});

await step('worker_during_call', async () => {
  const at = now();
  agent.runner.heard('Can you have a worker check how many files are in /home/agent/ws-metro-119/metro/packages/core/src? Tell me when it is done.');
  await until('task', () => events.some((e) => e.t >= at && e.kind === 'task_notification'), 300_000);
  const done = events.find((e) => e.t >= at && e.kind === 'task_notification')?.t ?? 0;
  await until('spoken result', () => spoken.some((s) => s.t >= done));
  numbers.worker_during_call_first_words_after_done_ms = wordsAfter(done);
  numbers.worker_during_call_speech = spoken.find((s) => s.t >= done)?.text;
});

await step('call_end', async () => {
  agent.runner.heard('Thanks, bye for now.');
  await sleep(4000);
  const at = now();
  agent.runner.callEnded();
  await until('turn end', () => turnsSince(at) > 0).catch(() => 0);
  numbers.spoken_after_end = spoken.filter((s) => s.t > at + 50).length;
});

await step('restart', async () => {
  const before = agent.runner.id;
  await agent.stop();
  await agent.done.catch(() => undefined);
  const at = now();
  agent = await boot();
  const id = chat(LESS, 'Quick check after a restart: what did I ask you on the call, and what did the line count find? Two lines.');
  numbers.restart_first_react_ms = await until('react', () => reactsTo(id).length > 0);
  await until('answer', () => sendsOn(LINE, at).length > 0);
  numbers.restart_answer_ms = (sendsOn(LINE, at)[0]?.t ?? 0) - at;
  numbers.restart_same_session = agent.runner.id === before;
  numbers.restart_answer = sendsOn(LINE, at)[0]?.args.text;
});

await step('crash', async () => {
  const at = now();
  chat(LESS, 'Please write three short sentences about lighthouses and send them here.');
  await sleep(1200);
  const queued = chat(LESS, 'Also: what is 9 times 8? Answer here.');
  await sleep(300);
  numbers.crash_unanswered_before_stop = agent.runner.inbox.unanswered().length;
  await agent.stop();
  await agent.done.catch(() => undefined);
  agent = await boot();
  await until('9 times 8 answered', () => sendsOn(LINE, at).some((c) => String(c.args.text).includes('72')), 180_000).then(
    (ms) => {
      numbers.crash_queued_answered_after_restart_ms = ms;
    },
    () => {
      numbers.crash_queued_answered_after_restart_ms = null;
    },
  );
  numbers.crash_queued_id = queued;
  numbers.crash_sends = sendsOn(LINE, at).map((c) => String(c.args.text).slice(0, 80));
});

await step('compact', async () => {
  const filler = Array.from({ length: 4000 }, (_, i) => `Log line ${String(i)}: the box reported a routine heartbeat with nothing unusual to note.`).join('\n');
  const big = now();
  chat(LESS, `Here is a log for your context only, no action needed, just answer "noted" here.\n${filler}`);
  await until('noted', () => sendsOn(LINE, big).length > 0, 180_000);
  numbers.compact_big_turn_answer_ms = (sendsOn(LINE, big)[0]?.t ?? 0) - big;
  await until('auto compaction starts', () => events.some((e) => e.t >= big && e.kind === 'status' && e.data.status === 'compacting'), 120_000);
  const started = events.find((e) => e.t >= big && e.kind === 'status' && e.data.status === 'compacting')?.t ?? now();
  await sleep(2000);
  const cut = now();
  agent.runner.callStarted('in your direct chat with Less on telegram-bot, line ' + LINE);
  await until('greeting during compaction', () => spoken.some((s) => s.t >= cut), 180_000);
  numbers.compact_call_greeting_first_words_ms = wordsAfter(cut);
  numbers.compact_stalled_signal = stalls.some((t) => t >= cut);
  await until('compacted', () => events.some((e) => e.t >= started && e.kind === 'compact_boundary'), 600_000).catch(() => 0);
  numbers.compact_ms = (events.find((e) => e.t >= started && e.kind === 'compact_boundary')?.t ?? 0) - started;
  numbers.compact_meta = events.find((e) => e.t >= started && e.kind === 'compact_boundary')?.data.meta;
  agent.runner.callEnded();
  await sleep(3000);
  const q = now();
  chat(LESS, 'After the compaction: what was 6 times 7 earlier, and who asked you about 17 times 3? One line.');
  await until('answer', () => sendsOn(LINE, q).length > 0);
  numbers.compact_after_answer_ms = (sendsOn(LINE, q)[0]?.t ?? 0) - q;
  numbers.compact_after_answer = sendsOn(LINE, q)[0]?.args.text;
});

numbers.lost = lostReason;
numbers.turns = events.filter((e) => e.kind === 'result').length;
numbers.cost_usd = [...events].reverse().find((e) => e.kind === 'result')?.data.cost;
say('numbers', numbers);
await agent.stop();
http.close();
process.exit(0);
