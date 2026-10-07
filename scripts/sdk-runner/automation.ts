import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { query, type HookCallback, type SDKUserMessage } from '../../packages/sdk-runner/node_modules/@anthropic-ai/claude-agent-sdk';
import { AutomationStore, type AutomationRequest, type AutomationOutcome } from '../../packages/core/src/automation-store.ts';
import { Activity } from '../../packages/sdk-runner/src/activity.ts';
import { automationRoot } from '../../packages/sdk-runner/src/automation-command.ts';
import { runnerConfig } from '../../packages/sdk-runner/src/config.ts';
import { Runner, runnerOptions } from '../../packages/sdk-runner/src/runner.ts';
import { SessionStore } from '../../packages/sdk-runner/src/session-store.ts';
import { metroTools } from '../../packages/sdk-runner/src/tool-proxy.ts';
import { automationUpstream } from './automation-upstream.ts';

const root = mkdtempSync(join(tmpdir(), 'sdk-automation-check-'));
const dirs = Object.fromEntries(['home', 'claude', 'tmp', 'runtime', 'cache', 'config'].map((name) => {
  const path = join(root, name);
  mkdirSync(path, { mode: 0o700 });
  return [name, path];
}));
const home = dirs.home!;
const env = {
  PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: home, CLAUDE_CONFIG_DIR: dirs.claude!, TMPDIR: dirs.tmp!,
  XDG_RUNTIME_DIR: dirs.runtime!, XDG_CACHE_HOME: dirs.cache!, XDG_CONFIG_HOME: dirs.config!,
  ANTHROPIC_API_KEY: 'fixture-key', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  BROWSER: 'none', CI: '1', NODE_OPTIONS: '--max-old-space-size=1500',
};
for (const name of Object.keys(process.env)) delete process.env[name];
Object.assign(process.env, env);
assert.equal(Bun.which('metro'), null, 'the isolated PATH has no metro executable');
const upstream = await automationUpstream();
const statePath = join(root, 'session.json');
const sdkEnv = { ...env, ANTHROPIC_BASE_URL: upstream.base, METRO_RUNNER_STATE: statePath };
const effectPath = join(root, 'effects.jsonl');
const store = new SessionStore(statePath, dirs.claude!, home);
const queueRoot = automationRoot(sdkEnv);
assert.equal(queueRoot, join(root, 'automation'));
const automation = new AutomationStore(queueRoot);
const cfg = runnerConfig({ ...sdkEnv, METRO_RUNNER_MCP_URL: `${upstream.base}/mcp`, METRO_AGENT_KEY: 'fixture-key', METRO_RUNNER_MODEL: 'claude-opus-5-5' }, home);
assert.equal(sdkEnv.METRO_RUNNER_STATE, cfg.statePath);
assert.equal(process.env.BUN_RUNTIME_TRANSPILER_CACHE_PATH, undefined);
const envelopes: { uuid: string; origin: SDKUserMessage['origin']; clientComposed?: boolean }[] = [];
const effects: string[] = [];
const mcpReceipts: { uuid: string; outcome: AutomationOutcome }[] = [];
const bashCalls: { uuid: string; toolUseId: string; agentId: string; command: string }[] = [];
const results: string[][] = [];
const sessionIds = new Set<string>();
const tasks = new Set<string>();
const completedTasks = new Set<string>();
let runner: Runner;
let activity: Activity;
let done: Promise<void> = Promise.resolve();
let failure: unknown;
let slot = Date.now() - 60_000;

function report(data: object): void { process.stdout.write(`${JSON.stringify(data)}\n`); }

async function until(label: string, check: () => boolean): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (!check()) {
    if (failure !== undefined) throw failure;
    assert.deepEqual(upstream.errors, [], 'local upstream accepted the real SDK protocol');
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await Bun.sleep(25);
  }
}

async function* observed(prompt: AsyncIterable<SDKUserMessage>): AsyncIterable<SDKUserMessage> {
  for await (const message of prompt) {
    if (message.origin?.kind === 'task-notification') {
      assert.ok(message.uuid);
      assert.equal(automation.status(message.uuid)?.state, 'dispatched', 'durable dispatch fence precedes the SDK yield');
      assert.deepEqual(message.origin, { kind: 'task-notification', subkind: 'scheduled-trigger' });
      assert.equal(message.client_composed, true);
      const body: unknown = message.message;
      assert.ok(typeof body === 'object' && body !== null && 'content' in body && typeof body.content === 'string');
      assert.equal(body.content.includes('<channel'), false);
      envelopes.push({ uuid: message.uuid, origin: message.origin, clientComposed: message.client_composed });
    }
    yield message;
  }
}

const workerBash: HookCallback = (input) => {
  try {
    assert.equal(input.hook_event_name, 'PreToolUse');
    assert.ok(input.hook_event_name === 'PreToolUse' && input.tool_name === 'Bash');
    assert.ok(input.agent_id, 'Bash completion is executed by a real worker, never the main thread');
    assert.equal(input.cwd, home);
    const plan = upstream.bashCommands.get(input.tool_use_id);
    assert.ok(plan && upstream.workers.includes(plan.uuid), 'only the planned fixture worker Bash calls are allowed');
    assert.ok(typeof input.tool_input === 'object' && input.tool_input !== null && 'command' in input.tool_input);
    assert.equal(input.tool_input.command, plan.command, 'execute the host-provided command verbatim');
    bashCalls.push({ uuid: plan.uuid, toolUseId: input.tool_use_id, agentId: input.agent_id, command: plan.command });
    return Promise.resolve({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } });
  } catch (err) {
    failure = err;
    return Promise.resolve({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Not the isolated worker completion command.' } });
  }
};

function boot(): Runner {
  activity?.stop();
  activity = new Activity(join(root, 'activity.json'));
  activity.start();
  const tools = metroTools({
    instructions: undefined,
    listTools: () => Promise.resolve({ tools: ['fixture_effect', 'fixture_finish'].map((name) => ({
      name, description: 'Only this isolated fixture: record an effect or worker completion receipt.',
      inputSchema: { type: 'object', properties: { uuid: { type: 'string' }, token: { type: 'string' }, outcome: { type: 'string', enum: ['completed', 'blocked'] } }, required: ['uuid', 'token'] },
    })) }),
    callTool: (params) => {
      const { uuid, token, outcome } = params.arguments ?? {};
      assert.ok(typeof uuid === 'string' && typeof token === 'string');
      assert.equal(automation.status(uuid)?.token, token, 'fixture worker uses its dispatched identifiers');
      assert.ok(upstream.workers.includes(uuid), 'an actual SDK Agent worker requested the fixture action');
      if (params.name === 'fixture_effect') {
        effects.push(uuid);
        appendFileSync(effectPath, `${JSON.stringify({ uuid, token })}\n`, { mode: 0o600 });
      } else {
        assert.equal(params.name, 'fixture_finish');
        assert.ok(!upstream.bashCommands.has(`toolu_probe_${uuid}`), 'the actual-command delivery cannot use the fixture finish shortcut');
        assert.ok(outcome === 'completed' || outcome === 'blocked');
        automation.finish(uuid, token, outcome);
        mcpReceipts.push({ uuid, outcome });
      }
      return Promise.resolve({ content: [{ type: 'text', text: 'Fixture action recorded.' }] });
    },
  });
  runner = new Runner({ store, activity, automationStore: automation, readOnly: () => false, compactAt: 10_000_000, open: ({ prompt, options }) => query({ prompt: observed(prompt), options }) });
  failure = undefined;
  runner.start({
    ...runnerOptions(cfg, tools, () => Promise.resolve({ behavior: 'deny', message: 'Only isolated fixture tools are allowed.' }), store.resumable(), sdkEnv),
    settingSources: [], permissionMode: 'default', tools: ['Agent', 'Bash'], allowedTools: ['Agent', 'mcp__metro__fixture_effect', 'mcp__metro__fixture_finish'],
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [workerBash] }] },
    agents: { worker: { description: 'Isolated automation proof', prompt: 'Use only the supplied fixture identifiers and exact completion command.', tools: ['Bash', 'mcp__metro__fixture_effect', 'mcp__metro__fixture_finish'] } },
  });
  done = runner.run((message) => {
    const m: Record<string, unknown> = { ...message };
    if (typeof m.session_id === 'string') sessionIds.add(m.session_id);
    if (m.type === 'result' && Array.isArray(m.user_message_uuids)) results.push(m.user_message_uuids as string[]);
    if (m.type === 'system' && m.subtype === 'task_started' && typeof m.task_id === 'string') tasks.add(m.task_id);
    if (m.type === 'system' && m.subtype === 'task_notification' && m.status === 'completed' && typeof m.task_id === 'string') completedTasks.add(m.task_id);
  }).catch((err: unknown) => { failure = err; });
  return runner;
}

function submit(routine: string, prompt: string, outcome: AutomationOutcome = 'completed', hold = false, bash = false): AutomationRequest {
  slot += 1_000;
  const request = automation.submit(routine, slot, prompt);
  upstream.expect(request, outcome, hold, bash);
  return request;
}

function poll(): void { assert.ok(runner.automation); runner.automation.poll(); }
function count(ids: readonly string[], uuid: string): number { return ids.filter((id) => id === uuid).length; }

async function finished(uuid: string): Promise<void> {
  await until(`main result ${uuid}`, () => results.some((ids) => ids.includes(uuid)));
}

async function chat(marker: string): Promise<string> {
  const uuid = runner.chat({ content: marker, meta: { line: 'metro://fixture/account/chat', addressed: 'direct' } });
  await finished(uuid);
  assert.equal(count(upstream.chats, marker), 1);
  return uuid;
}

async function settled(request: AutomationRequest, state = 'completed'): Promise<void> {
  await finished(request.uuid);
  await until(`${request.routine} ${state}`, () => { poll(); return automation.status(request.uuid)?.state === state; });
}

async function stop(): Promise<void> {
  runner.close();
  await done;
  activity.stop();
}

function killFixtureChild(): number {
  const children = readdirSync('/proc').filter((name) => /^\d+$/.test(name)).filter((pid) => {
    try {
      const parts = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]?.split(' ');
      return Number(parts?.[1]) === process.pid && readlinkSync(`/proc/${pid}/cwd`) === home && readlinkSync(`/proc/${pid}/exe`).endsWith('/claude');
    } catch { return false; }
  });
  assert.equal(children.length, 1, 'SIGKILL targets only our isolated SDK child, never a live session');
  const pid = Number(children[0]);
  const childEnv = readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0');
  for (const key of ['HOME', 'CLAUDE_CONFIG_DIR', 'TMPDIR', 'XDG_RUNTIME_DIR', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'PATH', 'METRO_RUNNER_STATE']) {
    assert.ok(childEnv.includes(`${key}=${sdkEnv[key as keyof typeof sdkEnv]}`));
  }
  assert.ok(childEnv.includes('ANTHROPIC_API_KEY=fixture-key'));
  assert.ok(!childEnv.some((entry) => /^(ANTHROPIC_AUTH_TOKEN|CLAUDE_CODE_OAUTH_TOKEN|AWS_ACCESS_KEY_ID|OPENAI_API_KEY|GOOGLE_API_KEY)=/.test(entry)));
  process.kill(pid, 'SIGKILL');
  return pid;
}

async function completionGate(session: string): Promise<void> {
  const first = submit('fixture-repeat', 'Check only this fixture. Quotes " stay JSON encoded.\nNo external action.', 'completed', true, true);
  const duplicate = automation.submit(first.routine, first.slot, first.prompt);
  assert.equal(duplicate.uuid, first.uuid);
  assert.equal(automation.status(first.uuid), null, 'offline acceptance does not pretend to dispatch');
  boot();
  await finished(first.uuid);
  await until('fixture worker effect before delayed receipt', () => upstream.held.has(first.uuid));
  const probe = upstream.bashResults.find((result) => result.toolUseId === `toolu_probe_${first.uuid}`);
  assert.ok(probe, 'the real background worker probed its actual shell environment');
  const environment = Object.fromEntries(probe.output.trim().split('\n').map((line) => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)]; }));
  assert.equal(environment.FIXTURE_HOME, home);
  assert.equal(environment.FIXTURE_STATE, cfg.statePath);
  assert.equal(environment.FIXTURE_PATH, sdkEnv.PATH);
  assert.equal(environment.FIXTURE_METRO, '', 'there is no metro in the actual worker shell PATH');
  assert.equal(environment.FIXTURE_CACHE, '', 'cache disabling belongs only to the completion subprocess');
  assert.equal(runner.id, session);
  assert.equal(automation.status(first.uuid)?.state, 'awaiting-completion');
  assert.equal(count(effects, first.uuid), 1);
  assert.ok(!automation.resolutions().some((receipt) => receipt.uuid === first.uuid));
  const next = submit(first.routine, 'Run only after the first sweep worker explicitly finishes.');
  for (let attempt = 0; attempt < 4; attempt++) { poll(); await Bun.sleep(100); }
  const ordinaryChat = await chat('AUTOMATION_CHAT_DURING_WORKER');
  assert.equal(automation.status(next.uuid), null, 'parent result does not unlock the next routine slot');
  assert.equal(count(upstream.workers, next.uuid), 0);
  assert.equal(count(envelopes.map((entry) => entry.uuid), first.uuid), 1);
  const actual = upstream.scheduled.find((entry) => entry.uuid === first.uuid)!;
  report({ check: 'offline delivery and explicit worker gate', session, ordinaryChat, delivery: first.uuid, duplicate: duplicate.uuid, pending: next.uuid, state: automation.status(first.uuid)?.state, effectCount: count(effects, first.uuid), sdkEnvelope: envelopes.find((entry) => entry.uuid === first.uuid), actualUpstreamText: actual.text, upstreamContainsChannel: actual.text.includes('<channel'), upstreamContainsOriginFrame: actual.text.includes('<task-notification') });
  upstream.release(first.uuid);
  await settled(first);
  await settled(next);
  assert.equal(count(effects, next.uuid), 1);
  automation.submit(first.routine, first.slot, first.prompt);
  poll();
  assert.equal(count(upstream.workers, first.uuid), 1);
  await until('first two workers completed', () => completedTasks.size === 2);
  const commandCalls = bashCalls.filter((call) => call.toolUseId === `toolu_bash_finish_${first.uuid}`);
  const commandResults = upstream.bashResults.filter((result) => result.toolUseId === `toolu_bash_finish_${first.uuid}`);
  assert.equal(commandCalls.length, 1);
  assert.equal(commandResults.length, 1);
  assert.ok(commandCalls.every((call) => tasks.has(call.agentId)), 'Bash belongs to a real SDK worker task');
  assert.ok(mcpReceipts.every((receipt) => receipt.uuid !== first.uuid));
  assert.equal(automation.resolutions().filter((receipt) => receipt.uuid === first.uuid).length, 1);
  report({ check: 'actual worker Bash receipt unlocks next slot', session: runner.id, completed: [first.uuid, next.uuid], effectCounts: [count(effects, first.uuid), count(effects, next.uuid)], queueRoot, workerEnvironment: environment, metroInPath: false, completionBash: commandCalls[0], completionOutput: commandResults[0]?.output, completionReceiptCount: 1, workerReceipts: automation.resolutions() });
  await stop();
}

async function offlineCoalescing(session: string): Promise<void> {
  const missed = [submit('fixture-missed', 'Old offline slot one.'), submit('fixture-missed', 'Old offline slot two.'), submit('fixture-missed', 'Latest offline slot only.')];
  assert.ok(missed.every((request) => automation.status(request.uuid) === null));
  boot();
  await settled(missed[2]!);
  assert.equal(runner.id, session);
  assert.deepEqual(missed.map((request) => automation.status(request.uuid)?.state), ['coalesced', 'coalesced', 'completed']);
  assert.deepEqual(missed.map((request) => count(upstream.workers, request.uuid)), [0, 0, 1]);
  assert.deepEqual(missed.map((request) => count(effects, request.uuid)), [0, 0, 1]);
  await until('latest-only worker completed', () => completedTasks.size === 3);
  report({ check: 'offline missed ticks latest only', session: runner.id, deliveries: missed.map((request) => request.uuid), states: missed.map((request) => automation.status(request.uuid)?.state), effectCounts: missed.map((request) => count(effects, request.uuid)) });
}

async function interruptedFence(session: string): Promise<AutomationRequest> {
  const active = submit('fixture-crash', 'Perform one fixture-only effect, then wait before its completion receipt.', 'completed', true);
  poll();
  await finished(active.uuid);
  await until('fixture effect before hard kill', () => upstream.held.has(active.uuid));
  const next = submit(active.routine, 'This must stay pending behind the interrupted delivery.');
  assert.equal(count(effects, active.uuid), 1);
  assert.ok(!automation.resolutions().some((receipt) => receipt.uuid === active.uuid));
  const killedPid = killFixtureChild();
  await done;
  assert.ok(failure, 'the actual SDK rejects after SIGKILL');
  await stop();
  boot();
  await chat('AUTOMATION_CHAT_AFTER_CRASH');
  await until('exact recovery acknowledgment after restart', () => {
    const saved = JSON.parse(readFileSync(statePath, 'utf8')) as { tasks: { id: string; notice: unknown }[] };
    return saved.tasks.find((task) => task.id === `input:${active.uuid}`)?.notice === null && upstream.acknowledgments.length > 0;
  });
  assert.equal(runner.id, session);
  assert.equal(automation.status(active.uuid)?.state, 'interrupted');
  for (let attempt = 0; attempt < 6; attempt++) { poll(); await Bun.sleep(100); }
  assert.equal(automation.status(next.uuid), null);
  assert.equal(count(upstream.workers, active.uuid), 1);
  assert.equal(count(upstream.workers, next.uuid), 0);
  assert.equal(count(effects, active.uuid), 1);
  assert.equal(count(envelopes.map((entry) => entry.uuid), active.uuid), 1);
  report({ check: 'SIGKILL after effect before receipt never replays', killedPid, session: runner.id, delivery: active.uuid, pending: next.uuid, state: automation.status(active.uuid)?.state, effectCount: count(effects, active.uuid), workerRuns: count(upstream.workers, active.uuid), recoveryAcknowledgments: upstream.acknowledgments.slice() });
  return active;
}

async function blockedFence(): Promise<AutomationRequest> {
  const blocked = submit('fixture-blocked', 'Fixture worker records its blocker, without claiming completion.', 'blocked');
  poll();
  await settled(blocked, 'failed');
  const next = submit(blocked.routine, 'This must not repeat a blocked routine.');
  await chat('AUTOMATION_CHAT_WITH_BLOCKED_ROUTINE');
  const before = upstream.workers.length;
  await Bun.sleep(5_200);
  poll();
  assert.equal(automation.status(next.uuid), null);
  assert.equal(upstream.workers.length, before, 'periodic polling starts no blocked or interrupted routine');
  assert.equal(count(effects, blocked.uuid), 1);
  assert.equal(count(upstream.workers, blocked.uuid), 1);
  assert.ok(automation.resolutions().some((receipt) => receipt.uuid === blocked.uuid && receipt.outcome === 'blocked'));
  report({ check: 'blocked worker receipt fences later slots', session: runner.id, delivery: blocked.uuid, pending: next.uuid, state: automation.status(blocked.uuid)?.state, effectCount: count(effects, blocked.uuid), extraWorkerRuns: upstream.workers.length - before });
  return blocked;
}

runner = boot();
try {
  await chat('AUTOMATION_CHAT_WARM');
  const session = runner.id;
  assert.ok(session);
  await stop();
  await completionGate(session);
  await offlineCoalescing(session);
  const interrupted = await interruptedFence(session);
  const blocked = await blockedFence();
  assert.equal(sessionIds.size, 1);
  assert.equal(upstream.workers.length, 5);
  assert.equal(tasks.size, 5, 'the real SDK started exactly the five expected worker tasks');
  assert.equal(envelopes.length, 5);
  assert.equal(upstream.scheduled.length, 5);
  assert.equal(effects.length, 5);
  assert.equal(mcpReceipts.length, 3);
  assert.equal(automation.resolutions().length, 4);
  assert.equal(bashCalls.length, 2, 'one worker environment probe and one actual finish command');
  assert.equal(upstream.bashResults.length, 2);
  assert.ok(bashCalls.every((call) => tasks.has(call.agentId)));
  assert.equal(readFileSync(effectPath, 'utf8').trim().split('\n').length, 5);
  assert.deepEqual(upstream.errors, []);
  report({ pass: true, fixture: root, sessionIds: [...sessionIds], deliveries: envelopes.map((entry) => entry.uuid), sdkWorkerTasks: [...tasks], scheduledInputs: envelopes.length, expectedWorkerRuns: 5, actualWorkerRuns: upstream.workers.length, extraTaskRuns: tasks.size - 5, effects: effects.map((uuid) => ({ uuid, count: count(effects, uuid) })), workerReceipts: automation.resolutions().length, mcpReceipts: mcpReceipts.length, bashFinishCalls: bashCalls.filter((call) => call.toolUseId.startsWith('toolu_bash_finish_')).length, metroInPath: false, interrupted: interrupted.uuid, blocked: blocked.uuid, upstreamRequests: upstream.requests, liveProviderCalls: 0 });
} finally {
  await stop();
  upstream.close();
}
