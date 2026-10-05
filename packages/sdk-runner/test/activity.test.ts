import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { Activity, failureSummary } from '../src/activity.ts';
import { startAgent } from '../src/app.ts';
import { runnerConfig } from '../src/config.ts';
import { claimRunner } from '../src/singleton.ts';
import { Runner, type OpenSession } from '../src/runner.ts';
import { SessionStore } from '../src/session-store.ts';

const dirs: string[] = [];
const fixture = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'metro-sdk-activity-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const msg = (value: Record<string, unknown>): SDKMessage => value as unknown as SDKMessage;

function monitoring(): { activity: Activity; path: string } {
  const path = join(fixture(), 'status.json');
  return { activity: new Activity(path), path };
}

describe('SDK activity uses existing Terminal and a bounded private status snapshot', () => {
  test('distinguishes startup, work, tools, approval, background tasks and compaction', () => {
    const { activity, path } = monitoring();
    activity.start();
    expect(activity.snapshot().phase).toBe('starting');
    activity.connected();
    expect(activity.snapshot().phase).toBe('idle');
    activity.pending(2);
    expect(activity.snapshot().phase).toBe('working');
    activity.observe(msg({ type: 'system', subtype: 'init', session_id: '11111111-1111-4111-8111-111111111111' }));
    activity.observe(msg({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'PRIVATE-COMMAND' } }] } }));
    expect(activity.snapshot().tools).toEqual(['Bash']);
    activity.approval('a', { tool: 'Bash', worker: null });
    expect(activity.snapshot().phase).toBe('approval');
    activity.approval('a', null);
    activity.observe(msg({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'PRIVATE-RESULT' }] } }));
    activity.observe(msg({ type: 'system', subtype: 'task_started', task_id: 'worker-1', description: 'PRIVATE-PROMPT' }));
    activity.pending(0);
    activity.observe(msg({ type: 'result', subtype: 'success', is_error: false }));
    expect(activity.snapshot()).toMatchObject({ phase: 'working', workers: 1, tools: [], pending: 0 });
    activity.observe(msg({ type: 'system', subtype: 'task_notification', task_id: 'worker-1', status: 'completed', summary: 'PRIVATE-SUMMARY' }));
    expect(activity.snapshot().phase).toBe('idle');
    activity.observe(msg({ type: 'system', subtype: 'status', status: 'compacting' }));
    expect(activity.snapshot().phase).toBe('compacting');
    activity.stop();
    expect(activity.snapshot().phase).toBe('stopped');
    expect(readFileSync(path, 'utf8')).not.toContain('PRIVATE');
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test('surfaces error results including success-shaped API errors without copying private error text', () => {
    const { activity, path } = monitoring();
    activity.connected();
    activity.observe(msg({ type: 'result', subtype: 'success', is_error: true, result: 'secret sk-private provider response' }));
    expect(activity.snapshot()).toMatchObject({ phase: 'error', lastError: expect.stringContaining('provider_error') });
    activity.observe(msg({ type: 'result', subtype: 'error_max_turns', is_error: true, errors: ['secret error data'] }));
    expect(activity.snapshot().lastError).toContain('error_max_turns');
    activity.observe(msg({ type: 'result', subtype: 'success', is_error: false }));
    expect(activity.snapshot().phase).toBe('idle');
    activity.fail(failureSummary(new Error('401 secret-token')));
    activity.stop();
    expect(activity.snapshot().phase).toBe('error');
    expect(readFileSync(path, 'utf8')).not.toContain('secret');
  });

  test('tool failure has a name, not its input/output; ambient tasks do not count as work', () => {
    const { activity, path } = monitoring();
    activity.connected();
    activity.observe(msg({ type: 'system', subtype: 'task_started', task_id: 'watcher', tool_use_id: 'amb-call', ambient: true }));
    activity.observe(msg({ type: 'assistant', parent_tool_use_id: 'amb-call', message: { content: [{ type: 'tool_use', id: 'hidden', name: 'Read', input: {} }] } }));
    activity.observe(msg({ type: 'user', parent_tool_use_id: 'amb-call', message: { content: [{ type: 'tool_result', tool_use_id: 'hidden', is_error: true, content: 'PRIVATE' }] } }));
    expect(activity.snapshot()).toMatchObject({ workers: 0, tools: [], tasks: [], lastError: null, phase: 'idle' });
    activity.observe(msg({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 't', name: 'Read', input: {} }] } }));
    activity.observe(msg({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't', is_error: true, content: 'private file contents' }] } }));
    expect(activity.snapshot()).toMatchObject({ lastError: null, activeFailure: null, lastFailure: { code: 'tool_error', tool: 'Read', toolUseId: 't' } });
    expect(readFileSync(path, 'utf8')).not.toContain('private file');
    activity.stop();
  });
});

test('real task events expose worker lifecycle without prompts or summaries', () => {
  const { activity, path } = monitoring();
  activity.connected();
  activity.observe(msg({ type: 'system', subtype: 'task_started', task_id: 'w1', tool_use_id: 'call-1', subagent_type: 'worker', task_type: 'local_agent', is_backgrounded: true, description: 'PRIVATE', prompt: 'PRIVATE' }));
  activity.observe(msg({ type: 'system', subtype: 'task_progress', task_id: 'w1', usage: { total_tokens: 100, tool_uses: 3, duration_ms: 1500 }, last_tool_name: 'Grep', summary: 'PRIVATE' }));
  expect(activity.snapshot()).toMatchObject({ workers: 1, phase: 'working', mainPhase: 'idle' });
  expect(activity.snapshot().tasks[0]).toMatchObject({ id: 'w1', agent: 'worker', kind: 'local_agent', status: 'running', background: true, lastTool: 'Grep', toolUses: 3, durationMs: 1500 });
  activity.observe(msg({ type: 'system', subtype: 'task_started', task_id: 'w2' }));
  activity.observe(msg({ type: 'system', subtype: 'task_updated', task_id: 'w2', patch: { status: 'killed' } }));
  activity.observe(msg({ type: 'system', subtype: 'task_notification', task_id: 'w1', status: 'failed', summary: 'PRIVATE' }));
  expect(activity.snapshot().tasks.find((task) => task.id === 'w1')?.status).toBe('failed');
  expect(activity.snapshot().tasks.find((task) => task.id === 'w2')?.status).toBe('stopped');
  expect(activity.snapshot().events.map(({ kind, taskId }) => [kind, taskId])).toEqual([
    ['task_failed', 'w1'], ['task_stopped', 'w2'], ['task_started', 'w2'], ['task_started', 'w1'],
  ]);
  expect(activity.snapshot()).toMatchObject({ workers: 0, phase: 'idle', lastError: null, activeFailure: null, lastFailure: { code: 'task_error', taskId: 'w1' } });
  expect(readFileSync(path, 'utf8')).not.toContain('PRIVATE');
  activity.stop();
});

test('background list replacement does not invent completion or revive finished tasks', () => {
  const { activity } = monitoring();
  activity.connected();
  activity.observe(msg({ type: 'system', subtype: 'task_started', task_id: 'bg1', is_backgrounded: true }));
  const replace = msg({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'bg2', task_type: 'local_bash', description: 'PRIVATE' }, { task_id: 'amb', ambient: true }] });
  activity.observe(replace);
  expect(activity.snapshot().tasks.map(({ id, status }) => [id, status])).toEqual([['bg2', 'running'], ['bg1', 'unknown']]);
  expect(activity.snapshot().tasks[1]?.endedAt).toBeNull();
  expect(activity.snapshot().workers).toBe(1);
  activity.observe(msg({ type: 'system', subtype: 'task_notification', task_id: 'bg2', status: 'completed' }));
  activity.observe(replace);
  expect(activity.snapshot().tasks.find((task) => task.id === 'bg2')?.status).toBe('completed');
  expect(activity.snapshot().workers).toBe(0);
  activity.stop();
});

test('an ambient task becoming active becomes visible along with its next tool', () => {
  const { activity, path } = monitoring();
  activity.connected();
  activity.observe(msg({ type: 'system', subtype: 'task_started', task_id: 'watcher', tool_use_id: 'watch-call', ambient: true }));
  activity.observe(msg({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'watcher', ambient: true }] }));
  expect(activity.snapshot().workers).toBe(0);
  activity.observe(msg({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'watcher', task_type: 'local_agent', ambient: false, description: 'PRIVATE' }] }));
  activity.observe(msg({ type: 'assistant', parent_tool_use_id: 'watch-call', message: { content: [{ type: 'tool_use', id: 'watch-read', name: 'Read', input: 'PRIVATE' }] } }));
  expect(activity.snapshot()).toMatchObject({ workers: 1, mainPhase: 'idle', activeTools: [{ id: 'watch-read', taskId: 'watcher' }] });
  expect(activity.snapshot().tasks[0]).toMatchObject({ id: 'watcher', status: 'running' });
  expect(readFileSync(path, 'utf8')).not.toContain('PRIVATE');
  activity.approval('ask', { tool: 'Read', worker: 'watcher' });
  activity.observe(msg({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'watcher', ambient: true }] }));
  activity.observe(msg({ type: 'assistant', parent_tool_use_id: 'watch-call', message: { content: [{ type: 'tool_use', id: 'hidden-again', name: 'Read' }] } }));
  activity.approval('hidden-ask', { tool: 'Read', worker: 'watcher' });
  expect(activity.snapshot()).toMatchObject({ workers: 0, activeTools: [], approvals: 0, mainPhase: 'idle' });
  activity.stop();
});

test('worker tools and approvals do not keep the main thread busy; heartbeats are not tools', () => {
  const { activity } = monitoring();
  activity.connected();
  activity.observe(msg({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 'call-1', name: 'Agent', input: {} }] } }));
  activity.observe(msg({ type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 'call-1' }] } }));
  activity.observe(msg({ type: 'system', subtype: 'task_started', task_id: 'w1', tool_use_id: 'call-1' }));
  activity.observe(msg({ type: 'result', subtype: 'success', is_error: false }));
  const before = activity.snapshot().events.length;
  activity.observe(msg({ type: 'assistant', parent_tool_use_id: 'call-1', message: { content: [{ type: 'tool_use', id: 'wt1', name: 'Read' }, { type: 'tool_use', id: 'wt2', name: 'Bash' }] } }));
  activity.observe(msg({ type: 'tool_progress', tool_use_id: 'call-1-heartbeat-0', tool_name: 'Agent', parent_tool_use_id: 'call-1', heartbeat: true, elapsed_time_seconds: 30 }));
  expect(activity.snapshot().activeTools.map(({ id, name, taskId }) => ({ id, name, taskId }))).toEqual([{ id: 'wt1', name: 'Read', taskId: 'w1' }, { id: 'wt2', name: 'Bash', taskId: 'w1' }]);
  expect(activity.snapshot()).toMatchObject({ phase: 'working', mainPhase: 'idle', mainStartedAt: null });
  expect(activity.snapshot().events).toHaveLength(before);
  activity.approval('ask', { tool: 'Bash', worker: 'w1' });
  expect(activity.snapshot()).toMatchObject({ phase: 'approval', mainPhase: 'idle' });
  expect(activity.snapshot().events[0]).toMatchObject({ kind: 'approval_waiting', tool: 'Bash', taskId: 'w1' });
  activity.approval('ask', null);
  expect(activity.snapshot().events[0]?.kind).toBe('approval_ended');
  activity.observe(msg({ type: 'system', subtype: 'task_notification', task_id: 'w1', status: 'completed' }));
  expect(activity.snapshot()).toMatchObject({ activeTools: [], phase: 'idle' });
  activity.stop();
});

test('worker tools arriving before their task retain attribution until the task is identified', () => {
  const { activity } = monitoring();
  activity.connected();
  activity.observe(msg({ type: 'assistant', parent_tool_use_id: 'late-call', message: { content: [{ type: 'tool_use', id: 'late-tool', name: 'Read' }] } }));
  expect(activity.snapshot()).toMatchObject({ mainPhase: 'idle', activeTools: [{ id: 'late-tool', taskId: null, worker: true }] });
  activity.observe(msg({ type: 'system', subtype: 'task_started', task_id: 'late-task', tool_use_id: 'late-call' }));
  expect(activity.snapshot().activeTools[0]).toMatchObject({ taskId: 'late-task', worker: true });
  activity.observe(msg({ type: 'system', subtype: 'task_notification', task_id: 'late-task', status: 'completed' }));
  expect(activity.snapshot().activeTools).toEqual([]);
  activity.stop();
});

test('records session, compaction, retry and denial events without private error text', () => {
  const { activity, path } = monitoring();
  activity.connected();
  activity.observe(msg({ type: 'system', subtype: 'session_state_changed', state: 'running' }));
  expect(activity.snapshot()).toMatchObject({ mainPhase: 'working', mainStartedAt: expect.any(Number) });
  activity.observe(msg({ type: 'system', subtype: 'status', status: 'compacting' }));
  activity.observe(msg({ type: 'system', subtype: 'status', status: 'compacting' }));
  activity.observe(msg({ type: 'system', subtype: 'status', status: 'requesting', compact_result: 'success' }));
  expect(activity.snapshot().phase).toBe('working');
  activity.observe(msg({ type: 'system', subtype: 'api_retry', error: 'PRIVATE' }));
  activity.observe(msg({ type: 'system', subtype: 'permission_denied', tool_name: 'Bash', decision_reason: 'PRIVATE' }));
  activity.observe(msg({ type: 'system', subtype: 'status', status: null, compact_result: 'failed', compact_error: 'PRIVATE' }));
  expect(activity.snapshot()).toMatchObject({ lastError: null, activeFailure: null, lastFailure: { code: 'compact_error' } });
  activity.observe(msg({ type: 'system', subtype: 'session_state_changed', state: 'idle' }));
  expect(activity.snapshot().mainStartedAt).toBeNull();
  expect(activity.snapshot().events.map(({ kind }) => kind)).toEqual(['compact_failed', 'permission_denied', 'api_retry', 'compacted', 'compacting', 'turn_started']);
  expect(readFileSync(path, 'utf8')).not.toContain('PRIVATE');
  activity.stop();
});

test('bounds rows and events and marks live tasks stopped on shutdown', () => {
  const { activity } = monitoring();
  activity.connected();
  for (let i = 0; i < 35; i++) activity.observe(msg({ type: 'system', subtype: 'task_started', task_id: `w${i}` }));
  for (let i = 0; i < 25; i++) activity.observe(msg({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: `t${i}`, name: 'Read' }] } }));
  expect(activity.snapshot().tasks).toHaveLength(30);
  expect(activity.snapshot().workers).toBe(35);
  expect(activity.snapshot().activeTools).toHaveLength(20);
  expect(activity.snapshot().events).toHaveLength(40);
  expect(activity.snapshot().events[0]).toMatchObject({ kind: 'tool_started', tool: 'Read' });
  activity.stop();
  expect(activity.snapshot()).toMatchObject({ workers: 0, activeTools: [], phase: 'stopped', mainPhase: 'stopped' });
  expect(activity.snapshot().tasks.every((task) => task.status === 'stopped')).toBe(true);
});

test('only one SDK process can claim a home, and exiting releases it', async () => {
  const home = fixture();
  const release = await claimRunner(home);
  try { await expect(claimRunner(home)).rejects.toThrow('already running'); }
  finally { await release(); }
  const next = await claimRunner(home);
  await next();
});

test('unwritable initial status refuses startup before MCP connects and releases ownership', async () => {
  const home = fixture();
  const path = join(home, '.metro', 'agent-status.json');
  mkdirSync(path, { recursive: true });
  const activity = new Activity(path);
  let calls = 0;
  const server = Bun.serve({ port: 10_000 + Math.floor(Math.random() * 20_000), hostname: '127.0.0.1', fetch: () => { calls++; return new Response('PRIVATE', { status: 503 }); } });
  try {
    const cfg = runnerConfig({ METRO_AGENT_KEY: 'fixture-key', METRO_RUNNER_MCP_URL: `${server.url}mcp` }, home);
    await expect(startAgent(cfg, { activity, lost: () => undefined, speech: { say: () => undefined, done: () => undefined } })).rejects.toThrow('SDK status file cannot be written');
    expect(calls).toBe(0);
    expect(activity.snapshot()).toMatchObject({ phase: 'error', lastError: 'The SDK status file cannot be written. Check its path and permissions before starting.' });
    expect(statSync(path).isDirectory()).toBe(true);
    const release = await claimRunner(home);
    await release();
  } finally {
    await server.stop(true);
  }
});

test('failed startup releases ownership and publishes a safe error', async () => {
  const home = fixture();
  const { activity } = monitoring();
  const server = Bun.serve({ port: 10_000 + Math.floor(Math.random() * 20_000), hostname: '127.0.0.1', fetch: () => new Response('PRIVATE', { status: 503 }) });
  try {
    const cfg = runnerConfig({ METRO_AGENT_KEY: 'fixture-key', METRO_RUNNER_MCP_URL: `${server.url}mcp` }, home);
    await expect(startAgent(cfg, { activity, lost: () => undefined, speech: { say: () => undefined, done: () => undefined } })).rejects.toThrow();
    expect(activity.snapshot().phase).toBe('error');
    expect(activity.snapshot().lastError).not.toContain('PRIVATE');
    if (process.platform === 'linux') expect(activity.snapshot().procStart).toMatch(/^\d+$/);
    const release = await claimRunner(home);
    await release();
  } finally {
    await server.stop(true);
  }
});

test('a crashed SDK process releases ownership without a stale file to remove', async () => {
  const home = fixture();
  const source = new URL('../src/singleton.ts', import.meta.url).pathname;
  const script = `import { claimRunner } from ${JSON.stringify(source)}; await claimRunner(${JSON.stringify(home)}); console.log('locked');`;
  const child = Bun.spawn([process.execPath, '-e', script], { stdout: 'pipe', stderr: 'pipe' });
  const reader = child.stdout.getReader();
  try {
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('locked');
    await expect(claimRunner(home)).rejects.toThrow('already running');
  } finally {
    child.kill('SIGKILL');
    await child.exited;
    reader.releaseLock();
  }
  const release = await claimRunner(home);
  await release();
});

test('a chat arriving between MCP connect and query start is queued once, alongside recovered input', async () => {
  const dir = fixture();
  const store = new SessionStore(join(dir, 's.json'), join(dir, 'claude'), dir);
  store.saveUnanswered([{ text: 'saved', at: Date.now() }]);
  const open: OpenSession = () => ({ applyFlagSettings: () => Promise.resolve(), close: () => undefined }) as never;
  const runner = new Runner({ store, open, readOnly: () => false, sink: { say: () => undefined, done: () => undefined } });
  runner.chat({ content: 'new event', meta: { line: 'metro://fixture/a/b' } });
  runner.start({});
  expect(store.unanswered()).toHaveLength(2);
  const messages = runner.inbox[Symbol.asyncIterator]();
  expect((await messages.next()).value?.message.content).toBe('saved');
  expect((await messages.next()).value?.message.content).toContain('new event');
  expect(() => runner.start({})).toThrow('already started');
  runner.close();
});
