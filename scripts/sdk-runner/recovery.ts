import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Activity } from '../../packages/sdk-runner/src/activity.ts';
import { runnerConfig } from '../../packages/sdk-runner/src/config.ts';
import { Runner, runnerOptions } from '../../packages/sdk-runner/src/runner.ts';
import { SessionStore } from '../../packages/sdk-runner/src/session-store.ts';
import { metroTools } from '../../packages/sdk-runner/src/tool-proxy.ts';
import { recoveryUpstream } from './recovery-upstream.ts';

const root = mkdtempSync(join(tmpdir(), 'sdk-recovery-check-'));
const home = join(root, 'home');
const claude = join(root, 'claude');
mkdirSync(home);
mkdirSync(claude);
const upstream = await recoveryUpstream();
const statePath = join(root, 'session.json');
const store = new SessionStore(statePath, claude, home);
const env = {
  PATH: process.env.PATH, HOME: home, CLAUDE_CONFIG_DIR: claude, TMPDIR: root,
  ANTHROPIC_BASE_URL: upstream.base, ANTHROPIC_API_KEY: 'fixture-key',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', BROWSER: 'none', CI: '1',
};
const cfg = runnerConfig({ ...env, METRO_RUNNER_MCP_URL: `${upstream.base}/mcp`, METRO_AGENT_KEY: 'fixture-key', METRO_RUNNER_MODEL: 'claude-opus-5-5', METRO_RUNNER_STATE: statePath }, home);
const calls: string[] = [];
const results: string[][] = [];
const lifecycle: Record<string, unknown>[] = [];
const failedWorkers: { id: string; owner: string | null; pending: boolean }[] = [];
let runner: Runner;
let activity: Activity;
let done: Promise<void> = Promise.resolve();
let failure: unknown;

async function until(label: string, check: () => boolean): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await Bun.sleep(20);
  }
}

function boot(): void {
  activity?.stop();
  activity = new Activity(join(root, 'activity.json'));
  activity.start();
  const tools = metroTools({
    instructions: undefined,
    listTools: () => Promise.resolve({ tools: [{ name: 'fixture_write', description: 'Record a fixture-only side effect.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] }),
    callTool: (params) => {
      calls.push(String(params.arguments?.text));
      return Promise.resolve({ content: [{ type: 'text', text: 'fixture recorded' }] });
    },
  });
  runner = new Runner({ store, activity, readOnly: () => false, compactAt: 10_000_000 });
  runner.start({
    ...runnerOptions(cfg, tools, () => Promise.resolve({ behavior: 'deny', message: 'Only fixture tools are allowed.' }), store.resumable(), env),
    settingSources: [], permissionMode: 'default', tools: ['Agent'], allowedTools: ['Agent', 'mcp__metro__fixture_write'],
    agents: { worker: { description: 'Isolated recovery proof', prompt: 'Use only the fixture request.', tools: [] } },
  });
  failure = undefined;
  done = runner.run((message) => {
    const m: Record<string, unknown> = { ...message };
    if (m.type === 'result') results.push(Array.isArray(m.user_message_uuids) ? m.user_message_uuids as string[] : []);
    if (m.type === 'command_lifecycle') lifecycle.push({ state: m.state, command_uuid: m.command_uuid });
    if (m.type === 'system' && m.subtype === 'task_notification' && m.status === 'failed') {
      const saved = JSON.parse(readFileSync(statePath, 'utf8')) as { tasks: { id: string; owner: string | null; notice: unknown }[] };
      const task = saved.tasks.find((row) => row.id === m.task_id);
      assert.ok(task, 'failure is saved before observers see it');
      failedWorkers.push({ id: task.id, owner: task.owner, pending: task.notice !== null });
    }
  }).catch((err: unknown) => { failure = err; });
}

function chat(text: string): ReturnType<Runner['chat']> {
  return runner.chat({ content: text, meta: { line: 'metro://fixture/account/chat', addressed: 'direct' } });
}

async function finished(uuid: string): Promise<void> {
  await until('terminal result', () => results.some((ids) => ids.includes(uuid)));
}

function killFixtureChild(): void {
  const children = readdirSync('/proc').filter((name) => /^\d+$/.test(name)).filter((pid) => {
    try {
      const parts = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]?.split(' ');
      return Number(parts?.[1]) === process.pid && readlinkSync(`/proc/${pid}/cwd`) === home && readlinkSync(`/proc/${pid}/exe`).endsWith('/claude');
    } catch { return false; }
  });
  assert.equal(children.length, 1, 'kill only the fixture SDK child');
  process.kill(Number(children[0]), 'SIGKILL');
}

async function crash(): Promise<void> {
  killFixtureChild();
  await done;
  assert.ok(failure, 'real SDK rejects when its child is killed');
  runner.close();
}

async function completedCrash(): Promise<void> {
  const warm = chat('RECOVERY_WARM');
  await finished(warm);
  const id = runner.id;
  assert.ok(id);
  const active = chat('RECOVERY_HOLD_MAIN');
  await until('held main API request', () => upstream.held.has('RECOVERY_HOLD_MAIN'));
  const queued = chat('RECOVERY_QUEUED');
  await Bun.sleep(150);
  assert.deepEqual(store.unanswered().map((input) => [input.uuid, input.state]), [[active, 'started'], [queued, 'queued']]);
  await crash();
  boot();
  await finished(queued);
  assert.equal(runner.id, id);
  assert.equal(calls.filter((text) => text === 'RECOVERY_QUEUED').length, 1);
  assert.equal(calls.filter((text) => text === 'RECOVERY_WARM').length, 1);
  assert.equal(upstream.seen.filter((text) => text === 'RECOVERY_HOLD_MAIN').length, 1);
  await until('recovery notice consumed', () => activity.snapshot().pending === 0);
  const saved = store.recover();
  assert.equal(saved.unanswered.length, 0);
  await until('main acknowledges interrupted input', () => store.recover().interrupted.length === 0);
  assert.equal(saved.unanswered.length, 0);
  assert.ok(!JSON.stringify(activity.snapshot()).includes('RECOVERY_HOLD_MAIN'));
  const before = lifecycle.filter((event) => event.command_uuid === warm && event.state === 'completed').length;
  runner.inbox.push('note', 'RECOVERY_WARM', undefined, warm);
  await until('SDK duplicate uuid acknowledgment', () => lifecycle.filter((event) => event.command_uuid === warm && event.state === 'completed').length > before);
  assert.equal(upstream.seen.filter((text) => text === 'RECOVERY_WARM').length, 1);
  assert.equal(results.filter((uuids) => uuids.includes(warm)).length, 1);
  process.stdout.write(`${JSON.stringify({ check: 'consumed crash', sameSession: true, queuedReplies: 1, completedReplies: 1, recoveryAcknowledged: true, uuidDedupAcknowledged: true, notice: activity.snapshot().lastError })}\n`);
}

async function sideEffectCrash(): Promise<void> {
  const active = chat('RECOVERY_SIDE_EFFECT');
  await until('held after side effect', () => upstream.held.has('toolu_RECOVERY_SIDE_EFFECT'));
  assert.equal(calls.filter((text) => text === 'RECOVERY_SIDE_EFFECT').length, 1);
  const queued = chat('RECOVERY_AFTER_SIDE');
  await Bun.sleep(100);
  await crash();
  store.saveUnanswered(store.unanswered().map((input) => input.uuid === active ? { ...input, state: 'queued' } : input));
  boot();
  await finished(queued);
  assert.equal(calls.filter((text) => text === 'RECOVERY_SIDE_EFFECT').length, 1);
  assert.equal(calls.filter((text) => text === 'RECOVERY_AFTER_SIDE').length, 1);
  await until('main acknowledges the side-effect interruption', () => store.recover().interrupted.length === 0);
  process.stdout.write(`${JSON.stringify({ check: 'side effect crash', sideEffects: 1, queuedReplies: 1, acknowledged: true, missedStartedReconciled: true })}\n`);
}

async function intentionalStop(): Promise<void> {
  const active = chat('RECOVERY_HOLD_STOP');
  await until('held before explicit Stop', () => upstream.held.has('RECOVERY_HOLD_STOP'));
  const queued = chat('RECOVERY_AFTER_STOP');
  await Bun.sleep(100);
  runner.close(true);
  await done;
  assert.ok(!store.unanswered().some((input) => input.uuid === active));
  boot();
  await finished(queued);
  assert.equal(store.recover().interrupted.length, 0);
  assert.equal(calls.filter((text) => text === 'RECOVERY_AFTER_STOP').length, 1);
  assert.equal(upstream.seen.filter((text) => text === 'RECOVERY_HOLD_STOP').length, 1);
  process.stdout.write(`${JSON.stringify({ check: 'intentional Stop', cancelledNotReplayed: true, queuedReplies: 1, noNewInterruption: true })}\n`);
}

async function interruptedOnly(): Promise<void> {
  const active = chat('RECOVERY_HOLD_ONLY');
  await until('held with no queued input', () => upstream.held.has('RECOVERY_HOLD_ONLY'));
  await crash();
  boot();
  await until('main acknowledges interruption without new chat', () => store.recover().interrupted.length === 0);
  assert.equal(upstream.seen.filter((text) => text === 'RECOVERY_HOLD_ONLY').length, 1);
  assert.equal(activity.snapshot().pending, 0);
  process.stdout.write(`${JSON.stringify({ check: 'interrupted without queue', noticeAcknowledged: true, noAutomaticReplay: true, input: active })}\n`);
}

async function workerRestart(): Promise<void> {
  const input = chat('RECOVERY_WORKER');
  await finished(input);
  await until('background child held after main completion', () => upstream.held.has('RECOVERY_HOLD_CHILD'));
  const id = runner.id;
  const before = JSON.parse(readFileSync(statePath, 'utf8')) as { tasks: { id: string; state: string; owner: string; notice: unknown }[] };
  const worker = before.tasks.find((task) => task.state === 'running');
  assert.ok(worker, 'worker persists after the main input result');
  assert.equal(worker.owner, 'main');
  assert.equal(store.unanswered().length, 0);
  await crash();
  boot();
  await until('main acknowledges unfinished worker after restart', () => {
    const saved = JSON.parse(readFileSync(statePath, 'utf8')) as typeof before;
    const task = saved.tasks.find((task) => task.id === worker.id);
    return task !== undefined && task.notice === null;
  });
  assert.equal(runner.id, id);
  assert.equal(calls.filter((text) => text === 'RECOVERY_WORKER').length, 0);
  process.stdout.write(`${JSON.stringify({ check: 'worker after main result and restart', sameSession: true, owner: 'main', worker: worker.id, recoveryAcknowledged: true, replayedSends: 0 })}\n`);
}

async function workerFailure(): Promise<void> {
  const input = chat('RECOVERY_FAILED_WORKER');
  await finished(input);
  await until('worker refusal held after main completion', () => upstream.held.has('RECOVERY_HOLD_REFUSAL'));
  const id = runner.id;
  upstream.refuse('RECOVERY_HOLD_REFUSAL');
  await until('actual SDK terminal worker failure', () => failedWorkers.length > 0);
  const worker = failedWorkers[0]!;
  assert.equal(worker.owner, 'main');
  assert.equal(worker.pending, true);
  await until('main acknowledges terminal worker failure', () => {
    const saved = JSON.parse(readFileSync(statePath, 'utf8')) as { tasks: { id: string; state: string; notice: unknown }[] };
    return saved.tasks.some((task) => task.id === worker.id && task.state === 'failed' && task.notice === null);
  });
  assert.equal(runner.id, id);
  assert.equal(calls.filter((text) => text === 'RECOVERY_FAILED_WORKER').length, 0);
  assert.equal(upstream.launched.filter((text) => text === 'RECOVERY_FAILED_WORKER').length, 1);
  process.stdout.write(`${JSON.stringify({ check: 'terminal worker failure after main result', sameSession: true, owner: 'main', failurePersistedBeforeNotification: true, recoveryAcknowledged: true, replayedSends: 0 })}\n`);
}

boot();
try {
  await completedCrash();
  await sideEffectCrash();
  await intentionalStop();
  await interruptedOnly();
  await workerRestart();
  await workerFailure();
  process.stdout.write(`${JSON.stringify({ pass: true, fixture: root, lifecycle })}\n`);
} finally {
  runner!.close();
  await done;
  upstream.close();
}
