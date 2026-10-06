import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { parseRunnerActivity, runnerFailureSummary } from '@metro-labs/core/runner-activity';
import { Activity } from '../src/activity.ts';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const msg = (value: Record<string, unknown>): SDKMessage => value as unknown as SDKMessage;
const result = (over: Record<string, unknown> = {}): SDKMessage => msg({ type: 'result', subtype: 'success', is_error: false, ...over });
const running = msg({ type: 'system', subtype: 'session_state_changed', state: 'running' });
const idle = msg({ type: 'system', subtype: 'session_state_changed', state: 'idle' });

function fixture(): { activity: Activity; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'metro-sdk-errors-'));
  dirs.push(dir);
  const path = join(dir, 'status.json');
  const activity = new Activity(path);
  activity.connected();
  return { activity, path };
}

test('provider 401 remains current through idle, then new main work and success retain only history', () => {
  const { activity, path } = fixture();
  activity.observe(running);
  activity.observe(result({ uuid: 'provider-event', is_error: true, api_error_status: 401, result: 'PRIVATE Bearer secret' }));
  const failure = activity.snapshot().activeFailure;
  expect(failure).toMatchObject({ id: 'provider-event', code: 'authentication', kind: 'turn_failed', at: expect.any(Number) });
  expect(activity.snapshot()).toMatchObject({ phase: 'error', lastError: runnerFailureSummary('authentication') });
  activity.observe(idle);
  activity.pending(1);
  activity.observe(msg({ type: 'system', subtype: 'api_retry' }));
  expect(activity.snapshot().activeFailure).toEqual(failure);
  activity.observe(running);
  expect(activity.snapshot()).toMatchObject({ phase: 'working', lastError: null, activeFailure: null, lastFailure: failure });
  activity.pending(0);
  activity.observe(result());
  expect(activity.snapshot()).toMatchObject({ phase: 'idle', mainPhase: 'idle', lastError: null, activeFailure: null, lastFailure: failure });
  expect(activity.snapshot().events.find((event) => event.id === failure?.id)).toEqual(failure);
  expect(parseRunnerActivity(JSON.parse(readFileSync(path, 'utf8')))).toMatchObject({ activeFailure: null, lastFailure: failure });
  expect(readFileSync(path, 'utf8')).not.toContain('PRIVATE');
});

test('structured assistant provider details are turn-scoped and worker errors cannot misclassify the main turn', () => {
  const { activity } = fixture();
  const assistant = (parent: string | null, error: string): SDKMessage => msg({ type: 'assistant', error, parent_tool_use_id: parent, message: { content: [{ type: 'text', text: 'PRIVATE provider text' }] } });
  activity.observe(assistant(null, 'billing_error'));
  activity.observe(result({ is_error: true }));
  expect(activity.snapshot().activeFailure?.code).toBe('billing');
  activity.observe(running);
  activity.observe(assistant('worker', 'authentication_failed'));
  activity.observe(result({ is_error: true }));
  expect(activity.snapshot().activeFailure?.code).toBe('provider_error');
  activity.observe(result({ subtype: 'error_max_budget_usd', is_error: true, errors: ['PRIVATE'] }));
  expect(activity.snapshot().activeFailure?.code).toBe('error_max_budget_usd');
  activity.observe(result());
  expect(activity.snapshot().lastError).toBeNull();
});

test('worker provider errors and restart interruptions remain distinct from generic failure and cancellation', () => {
  const { activity, path } = fixture();
  activity.observe(msg({ type: 'system', subtype: 'task_started', task_id: 'worker', tool_use_id: 'launch' }));
  activity.observe(msg({ type: 'assistant', parent_tool_use_id: 'launch', error: 'rate_limit', message: { content: [{ type: 'text', text: 'PRIVATE error' }] } }));
  activity.observe(msg({ type: 'system', subtype: 'task_notification', task_id: 'worker', status: 'failed' }));
  expect(activity.snapshot().lastFailure).toMatchObject({ taskId: 'worker', code: 'rate_limit' });
  activity.observe(msg({ type: 'system', subtype: 'task_started', task_id: 'worker', tool_use_id: 'launch' }));
  activity.observe(msg({ type: 'system', subtype: 'task_notification', task_id: 'worker', status: 'stopped', reason: 'worker_restart' }));
  expect(activity.snapshot().lastFailure).toMatchObject({ taskId: 'worker', code: 'interrupted' });
  expect(activity.snapshot().tasks[0]?.status).toBe('unknown');
  expect(readFileSync(path, 'utf8')).not.toContain('PRIVATE');
});

test('Read token limit is classified without copying tool I/O, and successful work never shows a current error', () => {
  const { activity, path } = fixture();
  activity.observe(msg({ type: 'system', subtype: 'task_started', task_id: 'worker', tool_use_id: 'delegate' }));
  activity.observe(msg({ type: 'assistant', parent_tool_use_id: 'delegate', message: { content: [{ type: 'tool_use', id: 'read-call', name: 'Read', input: { file_path: '/PRIVATE/path' } }] } }));
  activity.observe(msg({ type: 'user', parent_tool_use_id: 'delegate', message: { content: [{ type: 'tool_result', tool_use_id: 'read-call', is_error: true, content: [{ type: 'text', text: 'File content (30000 tokens) exceeds maximum allowed tokens (25000). PRIVATE file and token' }] }] } }));
  const failure = activity.snapshot().lastFailure;
  expect(failure).toMatchObject({ id: expect.any(String), at: expect.any(Number), kind: 'tool_failed', code: 'read_token_limit', tool: 'Read', taskId: 'worker', toolUseId: 'read-call' });
  expect(activity.snapshot()).toMatchObject({ activeFailure: null, lastError: null });
  activity.observe(result());
  activity.observe(msg({ type: 'system', subtype: 'task_notification', task_id: 'worker', status: 'completed', summary: 'PRIVATE' }));
  expect(activity.snapshot()).toMatchObject({ phase: 'idle', lastError: null, lastFailure: failure });
  expect(readFileSync(path, 'utf8')).not.toContain('PRIVATE');
  for (let i = 0; i < 50; i++) activity.observe(msg({ type: 'system', subtype: 'api_retry' }));
  expect(activity.snapshot().events).toHaveLength(40);
  expect(activity.snapshot().lastFailure).toEqual(failure);
});

test('a historical worker failure cannot replace a current main failure', () => {
  const { activity } = fixture();
  activity.observe(result({ is_error: true, api_error_status: 429 }));
  const current = activity.snapshot().activeFailure;
  activity.observe(msg({ type: 'system', subtype: 'task_notification', task_id: 'worker', status: 'failed', summary: 'PRIVATE' }));
  expect(activity.snapshot()).toMatchObject({ activeFailure: current, lastError: runnerFailureSummary('rate_limit'), lastFailure: { code: 'task_error', taskId: 'worker' } });
});

test('unexpected raw failures never persist and interrupted work stays current across other completed turns', () => {
  const { activity, path } = fixture();
  activity.fail('PRIVATE unexpected token from provider');
  expect(activity.snapshot().lastError).toBe(runnerFailureSummary('session_error'));
  activity.fail(runnerFailureSummary('interrupted'));
  const interrupted = activity.snapshot().activeFailure;
  activity.observe(running);
  activity.observe(result());
  expect(activity.snapshot()).toMatchObject({ phase: 'idle', activeFailure: interrupted, lastError: runnerFailureSummary('interrupted') });
  activity.observe(result({ is_error: true, api_error_status: 401 }));
  activity.observe(result());
  expect(activity.snapshot().activeFailure).toEqual(interrupted);
  const snapshot = activity.snapshot();
  if (snapshot.activeFailure) snapshot.activeFailure.at = 0;
  expect(activity.snapshot().activeFailure?.at).not.toBe(0);
  expect(readFileSync(path, 'utf8')).not.toContain('PRIVATE');
});
