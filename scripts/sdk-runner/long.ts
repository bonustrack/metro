import { writeFileSync } from 'node:fs';
import { ALICE, BOB, boot, calls, chat, close, CORE, events, GROUP, LESS, LINE, lost, reactsTo, say, sendsOn, settled, sleep, spoken, turnsSince, until, wordsAfter, now, type Turn } from './harness.ts';
import { COMPACT_AT } from '../../packages/sdk-runner/src/runner.ts';

const MESSAGES = Number(process.env.SDK_RUNNER_LONG_MESSAGES ?? 200);
const WORKERS = Number(process.env.SDK_RUNNER_LONG_WORKERS ?? 20);
const CALL_AT = Math.round(MESSAGES * 0.6);
const OUT = process.env.SDK_RUNNER_LONG_OUT ?? '/tmp/sdk-runner-long.json';
const FILES = ['events.ts', 'ids.ts', 'is-record.ts', 'lines.ts', 'log.ts', 'protocol.ts', 'secure-fs.ts', 'station-names.ts', 'str.ts', 'tickets.ts', 'train-error.ts', 'version.ts', 'endpoints.ts'];
const TOPICS = ['the Stage release', 'the MCI invoices', 'the Anderra flows', 'the Snapshot books', 'the box upgrade', 'the voice calls', 'the Gmail station', 'the X50 import'];
const NOTE_LINE = 'Item: the team agreed to move the weekly sync to Thursday, keep the release train on beta, and check the invoice exports before Friday. ';

let rng = 7;
const random = (): number => {
  rng = (rng * 1_103_515_245 + 12_345) % 2_147_483_648;
  return rng / 2_147_483_648;
};
const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)] as T;

interface Plan {
  kind: 'question' | 'ack' | 'long' | 'chatter' | 'recall' | 'worker';
  from: string;
  line: string;
  text: string;
}

function plan(i: number, asked: string[]): Plan {
  if (i % Math.max(1, Math.floor(MESSAGES / WORKERS)) === 3 && i / Math.floor(MESSAGES / WORKERS) < WORKERS) {
    const file = FILES[i % FILES.length] ?? 'log.ts';
    return { kind: 'worker', from: LESS, line: LINE, text: `Please have a background worker count the lines and the exported functions in ${CORE}/${file} and report both numbers here when done.` };
  }
  const roll = random();
  if (roll < 0.4) {
    const a = 3 + Math.floor(random() * 40);
    const b = 3 + Math.floor(random() * 40);
    asked.push(`${String(a)} times ${String(b)}`);
    return { kind: 'question', from: LESS, line: LINE, text: `Quick one: what is ${String(a)} times ${String(b)}? Answer here in one line.` };
  }
  if (roll < 0.52) return { kind: 'ack', from: LESS, line: LINE, text: pick(['ok thanks', 'Noted, thanks.', 'Perfect', 'Good, keep going.', 'I will be away for ten minutes.']) };
  if (roll < 0.62) return { kind: 'long', from: LESS, line: LINE, text: `Meeting notes about ${pick(TOPICS)}, just keep them in mind and answer "noted" here.\n${NOTE_LINE.repeat(12)}` };
  if (roll < 0.9) {
    const who = random() < 0.5 ? ALICE : BOB;
    return { kind: 'chatter', from: who, line: GROUP, text: `${pick(['Did anyone see', 'Quick update on', 'I am still waiting for', 'Can we talk tomorrow about'])} ${pick(TOPICS)}? ${pick(['No rush.', 'Thanks all.', 'Will check later.', ''])}` };
  }
  const earlier = asked.length > 2 ? asked[Math.floor(random() * (asked.length - 1))] : undefined;
  return { kind: 'recall', from: LESS, line: LINE, text: earlier === undefined ? 'What did I ask you so far today? One line.' : `Earlier I asked you about ${earlier}. What was the answer? One line.` };
}

interface Sample {
  i: number;
  kind: string;
  t: number;
  reactMs: number | null;
  replyMs: number | null;
  turnMs: number | null;
  context: number;
  costUsd: number;
}
const samples: Sample[] = [];

const contextOf = (usage: unknown): number => {
  const u = (usage ?? {}) as Record<string, number | undefined>;
  return (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
};
const lastOf = (kind: string): Turn | undefined => [...events].reverse().find((e) => e.kind === kind);
const lastCost = (): number => Number(lastOf('result')?.data.cost ?? 0);

async function handle(i: number, p: Plan): Promise<void> {
  const at = now();
  const id = chat(p.from, p.text, p.line);
  const answerable = p.kind !== 'chatter' && p.kind !== 'ack';
  await until('turn end', () => turnsSince(at) > 0, 180_000).catch(() => 0);
  if (answerable) await until('reply', () => sendsOn(p.line, at).length > 0, 60_000).catch(() => 0);
  const react = reactsTo(id)[0];
  const reply = sendsOn(p.line, at)[0];
  const result = events.find((e) => e.t >= at && e.kind === 'result');
  samples.push({
    i,
    kind: p.kind,
    t: at,
    reactMs: react === undefined ? null : react.t - at,
    replyMs: reply === undefined || p.line === GROUP ? null : reply.t - at,
    turnMs: result === undefined ? null : result.t - at,
    context: contextOf(lastOf('assistant')?.data.usage),
    costUsd: lastCost(),
  });
}

const callNumbers: Record<string, unknown> = {};
async function call(agent: Awaited<ReturnType<typeof boot>>): Promise<void> {
  await settled(1_500, false);
  const at = now();
  agent.runner.callStarted(`in your direct chat with Less on telegram-bot, line ${LINE}`);
  await until('greeting', () => spoken.some((s) => s.t >= at), 60_000).catch(() => 0);
  const words: number[] = [wordsAfter(at)];
  for (const sentence of ['Hi Emma, how many worker reports came in so far?', 'And what were the meeting notes about?', 'What was the last multiplication I asked you?', 'Thanks, that is all.']) {
    await sleep(1_500);
    const q = now();
    agent.runner.heard(sentence);
    await until('answer', () => spoken.some((s) => s.t >= q), 60_000).catch(() => 0);
    words.push(wordsAfter(q));
  }
  await sleep(2_000);
  agent.runner.callEnded();
  callNumbers.first_words_ms = words;
  callNumbers.spoken = spoken.filter((s) => s.t >= at).map((s) => s.text.slice(0, 160));
}

const quantile = (values: number[], q: number): number | null => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length === 0 ? null : (sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? null);
};
const spread = (values: (number | null)[]): Record<string, number | null> => {
  const v = values.filter((x): x is number => x !== null);
  return { n: v.length, p25: quantile(v, 0.25), p50: quantile(v, 0.5), p75: quantile(v, 0.75), p90: quantile(v, 0.9), max: quantile(v, 1) };
};

function compactions(): Record<string, unknown>[] {
  return events
    .filter((e) => e.kind === 'compact_boundary')
    .map((e) => {
      const started = [...events].reverse().find((s) => s.t <= e.t && s.kind === 'status' && s.data.status === 'compacting');
      return { at: e.t, ms: started === undefined ? null : e.t - started.t, meta: e.data.meta };
    });
}

function workerRelays(): (number | null)[] {
  return events
    .filter((e) => e.kind === 'task_notification')
    .map((e) => {
      const relay = calls.find((c) => c.t >= e.t && (c.action === 'send' || c.action === 'reply') && c.args.line === LINE);
      return relay === undefined ? null : relay.t - e.t;
    });
}

const agent = await boot(COMPACT_AT);
const asked: string[] = [];
const started = now();
for (let i = 0; i < MESSAGES; i += 1) {
  if (i === CALL_AT) await call(agent);
  const burst = i % 25 === 12 ? 3 : 1;
  const group = Array.from({ length: Math.min(burst, MESSAGES - i) }, (_, k) => plan(i + k, asked));
  if (group.length > 1) {
    await Promise.all(group.map(async (p, k) => {
      await sleep(k * 300);
      await handle(i + k, p);
    }));
    i += group.length - 1;
  } else if (group[0] !== undefined) await handle(i, group[0]);
  await sleep(500 + Math.floor(random() * 1_500));
  if (i % 10 === 9) say('progress', { i: i + 1, context: samples.at(-1)?.context, costUsd: lastCost(), minutes: Math.round((now() - started) / 60_000) });
}
await settled(5_000, true);

const final = lastOf('result')?.data;
const dm = samples.filter((s) => s.kind !== 'chatter');
const summary = {
  messages: samples.length,
  minutes: Math.round((now() - started) / 60_000),
  context: { start: samples[0]?.context, everyTwenty: samples.filter((s) => s.i % 20 === 19).map((s) => s.context), max: Math.max(...samples.map((s) => s.context)), end: samples.at(-1)?.context },
  compactions: compactions(),
  costUsd: final?.cost,
  models: final?.models,
  react: spread(dm.map((s) => s.reactMs)),
  reply: spread(dm.filter((s) => s.kind !== 'ack').map((s) => s.replyMs)),
  turn: spread(samples.map((s) => s.turnMs)),
  chatterAnswered: samples.filter((s) => s.kind === 'chatter' && sendsOn(GROUP, s.t).some((c) => c.t - s.t < 60_000)).length,
  chatterTotal: samples.filter((s) => s.kind === 'chatter').length,
  workers: { started: events.filter((e) => e.kind === 'task_started').length, reported: events.filter((e) => e.kind === 'task_notification').length, relayMs: spread(workerRelays()) },
  call: callNumbers,
  lost: lost(),
  claude: lastOf('init')?.data.claude,
};
writeFileSync(OUT, JSON.stringify({ summary, samples }, null, 2));
say('summary', summary);
await agent.stop();
close();
process.exit(0);
