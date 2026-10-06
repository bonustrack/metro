import { boot as bootAt, calls, chat, close, CORE, events, LESS, LINE, lost, OTHER, reactsTo, sendsOn, settled, sleep, standIn, turnsSince, until, say, now } from './harness.ts';

const numbers: Record<string, unknown> = {};
const COMPACT_AT = Number(process.env.SDK_RUNNER_CHECK_COMPACT_AT ?? 100_000);
const boot = (): ReturnType<typeof bootAt> => bootAt(COMPACT_AT);

const ONLY = (process.env.SDK_RUNNER_CHECK_STEPS ?? '').split(',').filter((n) => n !== '');
const step = async (name: string, body: () => Promise<void>): Promise<void> => {
  if (ONLY.length > 0 && !ONLY.includes(name)) return;
  await settled();
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
  chat(LESS, `Please count the TypeScript lines in each folder under ${CORE} (wc -l is fine) and report the total here.`);
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

await step('restart', async () => {
  const before = agent.runner.id;
  await agent.stop();
  await agent.done.catch(() => undefined);
  const at = now();
  agent = await boot();
  const id = chat(LESS, 'Quick check after a restart: what multiplication did I ask about, and what did the line count find? Two lines.');
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
  await until('compacted', () => events.some((e) => e.t >= started && e.kind === 'compact_boundary'), 600_000).catch(() => 0);
  numbers.compact_ms = (events.find((e) => e.t >= started && e.kind === 'compact_boundary')?.t ?? 0) - started;
  numbers.compact_meta = events.find((e) => e.t >= started && e.kind === 'compact_boundary')?.data.meta;
  await sleep(3000);
  const q = now();
  chat(LESS, 'After the compaction: what was 6 times 7 earlier, and what did the line count find? One line.');
  await until('answer', () => sendsOn(LINE, q).length > 0);
  numbers.compact_after_answer_ms = (sendsOn(LINE, q)[0]?.t ?? 0) - q;
  numbers.compact_after_answer = sendsOn(LINE, q)[0]?.args.text;
});

numbers.lost = lost();
numbers.claude_code = [...events].reverse().find((e) => e.kind === 'init')?.data.claude;
if (standIn !== null) numbers.key_route = standIn.stats;
numbers.turns = events.filter((e) => e.kind === 'result').length;
numbers.cost_usd = [...events].reverse().find((e) => e.kind === 'result')?.data.cost;
say('numbers', numbers);
await agent.stop();
close();
process.exit(0);
