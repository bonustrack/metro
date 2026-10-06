import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as h from './shared-call-harness.js';
import { toolEvents } from './shared-call-latency-metrics.js';
import { texts, type Block, type ModelRequest } from './shared-call-upstream.js';

const childScript = join(h.ROOT, 'wait-for-release.cjs');
writeFileSync(childScript, `const fs = require('node:fs');
const [base] = process.argv.slice(2);
fs.writeFileSync(base + '.pid', String(process.pid));
const timer = setInterval(() => {
  if (!fs.existsSync(base + '.release')) return;
  clearInterval(timer);
  fs.writeFileSync(base + '.done', 'LIFECYCLE_CHILD_DONE');
  process.stdout.write('LIFECYCLE_CHILD_DONE\\n');
}, 20);
`);
const taken = new Set<string>();
const quiet = (text = 'Lifecycle fixture bookkeeping finished.'): Block[] => [{ type: 'text', text }];
const take = (key: string): boolean => {
  if (taken.has(key)) return false;
  taken.add(key);
  return true;
};
const cases = ['foreground', 'background', 'terminated'] as const;
type Case = typeof cases[number];
const marker = (name: Case): string => `LIFECYCLE_${name.toUpperCase()}`;
const childBase = (name: Case): string => join(h.ROOT, name);
const quoted = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
const outcome = (name: Case): string => name === 'terminated' ? 'FAILED' : 'DONE';
const delivered = (name: Case): string => `${marker(name)}_${outcome(name)}_DELIVERED`;
const heldMs = Number(process.argv.find((arg) => arg.startsWith('--hold='))?.slice(7) ?? 0);
assert.ok(Number.isFinite(heldMs) && heldMs >= 0 && heldMs <= 90_000);
const observed: { name: Case; kind: 'notification' | 'outcome'; at: number }[] = [];

function worker(request: ModelRequest, name: Case): Block[] {
  request.worker = true;
  if (take(`child-${name}`)) return [{ type: 'tool_use', name: 'Bash', input: {
    command: `node ${quoted(childScript)} ${quoted(childBase(name))}`,
    description: 'Wait for the isolated lifecycle fixture release',
    timeout: 120000, run_in_background: name !== 'foreground',
  } }];
  const notified = request.text.includes('task-notification');
  if (notified) observed.push({ name, kind: 'notification', at: request.at });
  if (name === 'background' && notified && take('read-child-result'))
    return [{ type: 'tool_use', name: 'Read', input: { file_path: `${childBase(name)}.done` } }];
  const finished = name === 'terminated'
    ? notified && /<status>(failed|stopped)<\/status>/.test(request.text)
    : request.text.includes('LIFECYCLE_CHILD_DONE');
  if (finished) observed.push({ name, kind: 'outcome', at: request.at });
  return quiet(`${marker(name)}_WORKER_${finished ? outcome(name) : 'WAITING'}`);
}

h.upstream.script = (request: ModelRequest): Promise<Block[]> => {
  const first = texts(Array.isArray(request.body.messages) ? request.body.messages[0] : undefined);
  const workerCase = cases.find((name) => first.includes(`FIXTURE_WORKER_${marker(name)}`));
  if (workerCase !== undefined) return Promise.resolve(worker(request, workerCase));
  for (const name of cases) {
    if (request.text.includes(`${marker(name)}_START`) && take(`launch-${name}`)) return Promise.resolve([{ type: 'tool_use', name: 'Agent', input: {
      description: `Lifecycle ${name} worker`, prompt: `FIXTURE_WORKER_${marker(name)} Run the isolated fixture task.`,
      subagent_type: 'general-purpose', run_in_background: true,
    } }]);
    if (request.text.includes('task-notification') && request.text.includes(`${marker(name)}_WORKER_${outcome(name)}`))
      return Promise.resolve([{ type: 'tool_use', name: 'mcp__metro__send', input: { line: h.LINE, text: delivered(name) } }]);
  }
  return Promise.resolve(quiet());
};

type Event = typeof h.timedEvents[number];
const started = (event: Event): boolean => event.message.subtype === 'task_started';
const notified = (event: Event): boolean => event.message.subtype === 'task_notification';
function ordered(name: Case, events: Event[], releasedAt: number): void {
  const initial = events.find(started);
  assert.ok(initial);
  const workerId = initial.message.task_id;
  assert.equal(typeof workerId, 'string');
  const final = events.findLast((event) => notified(event) && event.message.task_id === workerId);
  assert.ok(final && final.message.status === 'completed' && final.at >= releasedAt);
  const receipt = toolEvents(delivered(name));
  assert.equal(receipt.length, 1);
  assert.ok(receipt[0].resultAt !== null && receipt[0].at >= final.at);
  assert.ok(!JSON.stringify(receipt[0].result).includes('"is_error":true'));
  assert.ok(observed.some((row) => row.name === name && row.kind === 'outcome' && row.at >= releasedAt && row.at <= final.at));
  if (name === 'foreground') return;
  const child = events.find((event) => started(event) && event.message.task_id !== workerId);
  assert.ok(child);
  const completion = events.find((event) => notified(event) && event.message.task_id === child.message.task_id);
  assert.ok(completion && completion.at >= releasedAt);
  assert.equal(completion.message.status, name === 'terminated' ? 'failed' : 'completed');
  const resumed = events.find((event) => started(event) && event.message.task_id === workerId && event.at >= completion.at);
  assert.ok(resumed && resumed.at <= final.at);
  assert.ok(observed.some((row) => row.name === name && row.kind === 'notification' && row.at >= completion.at));
}

function childPid(name: Case): number | undefined {
  const file = `${childBase(name)}.pid`;
  if (!existsSync(file)) return undefined;
  const text = readFileSync(file, 'utf8');
  if (text === '') return undefined;
  assert.match(text, /^[1-9]\d*$/);
  const pid = Number(text);
  assert.ok(Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid);
  assert.equal(String(pid), text);
  return pid;
}

function ownedChild(name: Case, pid: number): void {
  assert.equal(childPid(name), pid);
  const argv = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
  assert.deepEqual(argv.slice(1), [childScript, childBase(name), '']);
}

async function check(name: Case): Promise<void> {
  const base = childBase(name);
  const start = Date.now();
  const before = h.events.length;
  h.chat(`${marker(name)}_START`);
  await h.until('real child PID is complete', () => childPid(name) !== undefined);
  const session = h.agent.runner.id;
  assert.ok(session);
  const pid = childPid(name);
  assert.ok(pid !== undefined);
  ownedChild(name, pid);
  await h.until('main result while child waits', () => h.events.slice(before).some((event) => event.type === 'result' && event.parent_tool_use_id == null));
  assert.equal(existsSync(`${base}.done`), false);
  h.report('main result preserves waiting child', { name, elapsedMs: Date.now() - start, workers: h.activity.snapshot().workers, session });
  if (name !== 'foreground') {
    const initial = h.events.slice(before).find((event) => event.subtype === 'task_started');
    assert.ok(initial);
    await h.until('worker result before its child completes', () => h.events.slice(before).some((event) => event.subtype === 'task_notification' && event.task_id === initial.task_id && event.status === 'completed'));
    ownedChild(name, pid);
    h.report('worker result preserves background child', { name, workers: h.activity.snapshot().workers });
  }
  assert.equal(h.sent(delivered(name)), 0);
  if (name === 'background' && heldMs > 0) {
    await Bun.sleep(heldMs);
    ownedChild(name, pid);
    assert.equal(existsSync(`${base}.done`), false);
    assert.equal(h.sent(delivered(name)), 0);
    h.report('waiting child survives extended idle', { name, heldMs, elapsedMs: Date.now() - start });
  }
  ownedChild(name, pid);
  const releasedAt = Date.now();
  if (name === 'terminated') process.kill(pid, 'SIGTERM');
  else {
    writeFileSync(`${base}.release`, 'release');
    await h.until('real child finished after release', () => existsSync(`${base}.done`));
  }
  await h.until('SDK completion automatically resumes main and sends', () => h.sent(delivered(name)) === 1 && toolEvents(delivered(name)).some((row) => row.resultAt !== null));
  await h.idle();
  const events = h.timedEvents.slice(before);
  ordered(name, events, releasedAt);
  assert.equal(h.agent.runner.id, session);
  assert.equal(h.sent(delivered(name)), 1);
  assert.equal(h.activity.snapshot().workers, 0);
  await h.until('owned child exited', () => !existsSync(`/proc/${pid}`));
  assert.deepEqual(h.upstream.failures, []);
  if (name === 'terminated') assert.equal(existsSync(`${base}.done`), false);
  h.report('child completion resumes main and delivers outcome', { name, session, elapsedMs: Date.now() - start, releaseMs: releasedAt - start, delivered: 1, outcome: outcome(name),
    events: events.filter((event) => started(event) || notified(event) || event.message.type === 'result').map(({ at, message }) => ({ ms: at - start, type: message.type, subtype: message.subtype, task: message.task_id, status: message.status })) });
}

function evidence(): string {
  const file = join(h.ROOT, 'task-lifecycle-evidence.json');
  writeFileSync(file, JSON.stringify({ heldMs, observed, requests: h.upstream.seen, timedEvents: h.timedEvents, activity: h.activity.snapshot(), train: h.train }));
  return file;
}

try {
  await h.boot();
  for (const name of cases) await check(name);
  for (const name of cases) {
    assert.equal(h.sent(delivered(name)), 1);
    assert.equal(toolEvents(delivered(name)).length, 1);
  }
  assert.equal(h.train.filter((call) => call.action === 'send').length, cases.length);
  h.report('real SDK task lifecycle', { pass: true, cases, heldMs, evidence: evidence(), realProviderRequests: 0, paidCost: 0 });
} catch (err) {
  h.report('real SDK task lifecycle failed', { error: String(err), evidence: evidence() });
  throw err;
} finally {
  await h.close();
}
process.exit(0);
