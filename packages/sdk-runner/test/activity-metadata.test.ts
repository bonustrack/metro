import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { parseRunnerActivity } from '@metro-labs/core/runner-activity';
import { Activity } from '../src/activity.ts';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture(): { activity: Activity; path: string; observe: (value: Record<string, unknown>) => void } {
  const dir = mkdtempSync(join(tmpdir(), 'metro-task-metadata-'));
  dirs.push(dir);
  const path = join(dir, 'status.json');
  const activity = new Activity(path);
  return { activity, path, observe: (value) => { activity.observe(value as unknown as SDKMessage); } };
}

const start = (task_id: string, tool_use_id: string, description?: string): Record<string, unknown> => ({ type: 'system', subtype: 'task_started', task_id, tool_use_id, description });
const response = (parent_tool_use_id: string | null, model: unknown): Record<string, unknown> => ({ type: 'assistant', parent_tool_use_id, message: { model, content: [{ type: 'text', text: 'PRIVATE response' }] } });
const launch = (id: string, input: unknown, name = 'Agent'): Record<string, unknown> => ({ type: 'assistant', parent_tool_use_id: null, message: { model: 'main-model', content: [{ type: 'tool_use', id, name, input }] } });

test('only the short description crosses the task-event allowlist', () => {
  const { activity, path, observe } = fixture();
  observe(start('w', 'call', '  Inspect\tworker activity\nPRIVATE second line'));
  expect(activity.snapshot().tasks[0]?.description).toBe('Inspect worker activity');
  observe({ type: 'system', subtype: 'task_progress', task_id: 'w', description: 'PRIVATE activity description', summary: 'PRIVATE summary', usage: { tool_uses: 1, duration_ms: 100 } });
  expect(activity.snapshot().tasks[0]?.description).toBe('Inspect worker activity');
  observe({ type: 'system', subtype: 'task_updated', task_id: 'w', patch: { description: 'Review schema', prompt: 'PRIVATE prompt', progress: 'PRIVATE progress', status: 'running' } });
  expect(activity.snapshot().tasks[0]?.description).toBe('Review schema');
  observe({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'w', description: 'Verify schema', summary: 'PRIVATE summary' }] });
  expect(activity.snapshot().tasks[0]?.description).toBe('Verify schema');
  observe({ type: 'system', subtype: 'task_notification', task_id: 'w', status: 'completed', summary: 'PRIVATE result', output_file: 'PRIVATE path' });
  expect(activity.snapshot().tasks[0]).toMatchObject({ description: 'Verify schema', status: 'completed' });
  expect(readFileSync(path, 'utf8')).not.toContain('PRIVATE');
  expect(parseRunnerActivity(activity.snapshot())?.tasks[0]?.description).toBe('Verify schema');
});

test('Agent and legacy Task inputs supply descriptions, never prompts or requested models', () => {
  for (const name of ['Agent', 'Task']) {
    const { activity, path, observe } = fixture();
    observe(launch('call', { description: 'Review worker metadata', prompt: 'PRIVATE prompt', model: 'requested-model' }, name));
    observe(start('w', 'call'));
    expect(activity.snapshot().tasks[0]).toMatchObject({ description: 'Review worker metadata' });
    expect(activity.snapshot().tasks[0]?.lastObservedModel).toBeUndefined();
    expect(readFileSync(path, 'utf8')).not.toContain('PRIVATE');
    expect(readFileSync(path, 'utf8')).not.toContain('requested-model');
  }
  const { activity, observe } = fixture();
  observe(launch('call', { description: 'PRIVATE other tool' }, 'Bash'));
  observe(start('w', 'call'));
  expect(activity.snapshot().tasks[0]?.description).toBeUndefined();
});

test('models belong to the responding worker, including output before task identification', () => {
  const { activity, path, observe } = fixture();
  observe(response('early-call', 'openrouter:anthropic/worker-model'));
  expect(activity.snapshot().tasks).toEqual([]);
  observe(start('early', 'early-call', 'Early worker'));
  observe(start('other', 'other-call', 'Other worker'));
  observe(response('other-call', 'codex:other-model'));
  observe(response(null, 'main-selected-model'));
  observe({ type: 'user', parent_tool_use_id: 'early-call', message: { model: 'PRIVATE user model', content: [] } });
  observe({ type: 'system', subtype: 'init', session_id: '11111111-1111-4111-8111-111111111111', model: 'main-selected-model' });
  expect(activity.snapshot().tasks.find((row) => row.id === 'early')?.lastObservedModel).toBe('openrouter:anthropic/worker-model');
  expect(activity.snapshot().tasks.find((row) => row.id === 'other')?.lastObservedModel).toBe('codex:other-model');
  observe(response('early-call', 'fallback-observed-model'));
  for (const model of [undefined, '', '<synthetic>', 'PRIVATE\nmodel', 'a'.repeat(129), {}]) observe(response('early-call', model));
  expect(activity.snapshot().tasks.find((row) => row.id === 'early')?.lastObservedModel).toBe('fallback-observed-model');
  expect(readFileSync(path, 'utf8')).not.toContain('PRIVATE');
  expect(readFileSync(path, 'utf8')).not.toContain('main-selected-model');
});

test('known metadata survives completion, resume and sparse snapshots without inventing old metadata', () => {
  const { activity, observe } = fixture();
  observe(start('w', 'first', 'Inspect schema'));
  observe(response('first', 'worker-model'));
  observe({ type: 'system', subtype: 'task_notification', task_id: 'w', status: 'completed' });
  observe(launch('resumed', { to: 'w', message: 'PRIVATE' }, 'SendMessage'));
  observe(start('w', 'resumed'));
  observe(response('first', 'resumed-model'));
  observe({ type: 'system', subtype: 'task_updated', task_id: 'w', patch: { description: '\nPRIVATE', status: 'running' } });
  observe({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'w' }, { task_id: 'unknown', description: 'Recovered task' }] });
  expect(activity.snapshot().tasks.find((row) => row.id === 'w')).toMatchObject({ description: 'Inspect schema', lastObservedModel: 'resumed-model', status: 'running' });
  expect(activity.snapshot().tasks.find((row) => row.id === 'unknown')?.lastObservedModel).toBeUndefined();
  activity.stop();
  expect(activity.snapshot().tasks.find((row) => row.id === 'w')).toMatchObject({ description: 'Inspect schema', lastObservedModel: 'resumed-model', status: 'stopped' });
  const fresh = fixture();
  fresh.observe({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'w' }] });
  expect(fresh.activity.snapshot().tasks[0]?.description).toBeUndefined();
  expect(fresh.activity.snapshot().tasks[0]?.lastObservedModel).toBeUndefined();
});

test('the first genuine start survives progress, completion and same-ID resume', () => {
  const { activity, observe } = fixture();
  const clock = spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
  try {
    observe(start('w', 'first'));
    const startedAt = activity.snapshot().tasks[0]?.startedAt;
    expect(startedAt).toBe(1_800_000_000_000);
    clock.mockReturnValue(1_800_000_001_000);
    observe({ type: 'system', subtype: 'task_progress', task_id: 'w', usage: { tool_uses: 1, duration_ms: 500 } });
    observe({ type: 'system', subtype: 'task_notification', task_id: 'w', status: 'completed' });
    expect(activity.snapshot().tasks[0]).toMatchObject({ startedAt, status: 'completed', endedAt: 1_800_000_001_000 });
    clock.mockReturnValue(1_800_000_002_000);
    observe(start('w', 'resumed'));
    observe({ type: 'system', subtype: 'task_updated', task_id: 'w', patch: { status: 'paused' } });
    expect(activity.snapshot().tasks[0]).toMatchObject({ startedAt, status: 'paused', endedAt: null, updatedAt: 1_800_000_002_000 });
    observe({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'w' }, { task_id: 'sparse' }] });
    expect(activity.snapshot().tasks.find((row) => row.id === 'w')?.startedAt).toBe(startedAt);
    expect(activity.snapshot().tasks.find((row) => row.id === 'sparse')?.startedAt).toBe(0);
    clock.mockReturnValue(1_800_000_003_000);
    observe(start('sparse', 'late-start'));
    expect(activity.snapshot().tasks.find((row) => row.id === 'sparse')?.startedAt).toBe(1_800_000_003_000);
    activity.stop();
    expect(activity.snapshot().tasks.find((row) => row.id === 'w')).toMatchObject({ startedAt, status: 'stopped' });
  } finally { clock.mockRestore(); }
});

test('late progress or notification correlation links only observed metadata', () => {
  for (const subtype of ['task_progress', 'task_notification']) {
    const { activity, observe } = fixture();
    observe(launch('call', { description: 'Inspect task' }));
    observe(response('call', 'worker-model'));
    if (subtype === 'task_progress') observe({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'w' }] });
    observe({ type: 'system', subtype, task_id: 'w', tool_use_id: 'call', status: 'completed', description: 'PRIVATE progress', summary: 'PRIVATE result', usage: { tool_uses: 1, duration_ms: 100 } });
    expect(activity.snapshot().tasks[0]).toMatchObject({ description: 'Inspect task', lastObservedModel: 'worker-model' });
    expect(JSON.stringify(activity.snapshot())).not.toContain('PRIVATE');
  }
});

test('ambient and skipped tasks never publish their descriptions or models', () => {
  for (const flag of ['ambient', 'skip_transcript']) {
    const { activity, path, observe } = fixture();
    observe(launch('hidden-call', { description: 'PRIVATE description' }));
    observe(response('hidden-call', 'PRIVATE-model'));
    observe({ ...start('hidden', 'hidden-call', 'PRIVATE task'), [flag]: true });
    observe(response('hidden-call', 'PRIVATE-model'));
    expect(activity.snapshot().tasks).toEqual([]);
    expect(readFileSync(path, 'utf8')).not.toContain('PRIVATE');
  }
});

test('description and pending metadata are bounded while the 30-task display limit stays unchanged', () => {
  const { activity, observe } = fixture();
  for (let i = 0; i < 201; i++) observe(response(`call-${i}`, 'worker-model'));
  observe(start('evicted', 'call-0'));
  expect(activity.snapshot().tasks[0]?.lastObservedModel).toBeUndefined();
  for (let i = 1; i < 36; i++) observe(start(`w${i}`, `call-${i}`, 'x'.repeat(1000)));
  expect(activity.snapshot().tasks).toHaveLength(30);
  expect(activity.snapshot().tasks.filter((row) => row.id !== 'evicted').every((row) => row.description?.length === 160)).toBe(true);
});
