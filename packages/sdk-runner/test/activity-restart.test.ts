import { afterEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { parseRunnerActivity } from '@metro-labs/core/runner-activity';
import { Activity } from '../src/activity.ts';
import { Runner, type OpenSession } from '../src/runner.ts';
import { SessionStore } from '../src/session-store.ts';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const TASK = 'a0c9ca1e3572b2983';
const CALL = 'toolu_17922699023770';
const system = (fields: Record<string, unknown>): Record<string, unknown> => ({ type: 'system', uuid: randomUUID(), session_id: '14140634-eff1-41bb-aba8-3e1326393349', ...fields });

const observed = (): Record<string, unknown>[] => [
  { type: 'assistant', parent_tool_use_id: null, message: { model: 'vendor/model-a', content: [{ type: 'tool_use', id: CALL, name: 'Agent', input: { description: 'check', prompt: 'PRIVATE-PROMPT', subagent_type: 'worker', run_in_background: true } }] } },
  system({ subtype: 'background_tasks_changed', tasks: [{ task_id: TASK, task_type: 'local_agent', description: 'check' }] }),
  system({ subtype: 'task_started', task_id: TASK, tool_use_id: CALL, description: 'check', subagent_type: 'worker', is_backgrounded: true, spawn_depth: 1, task_type: 'local_agent', prompt: 'PRIVATE-PROMPT' }),
  system({ subtype: 'background_tasks_changed', tasks: [] }),
  system({ subtype: 'task_updated', task_id: TASK, patch: { status: 'completed', end_time: 1_792_269_904_015 } }),
  system({ subtype: 'task_notification', task_id: TASK, tool_use_id: CALL, status: 'completed', output_file: '/tmp/PRIVATE-OUTPUT', summary: 'PRIVATE-SUMMARY', usage: { total_tokens: 58, tool_uses: 0, duration_ms: 1609 } }),
];

function session(dir: string, messages: Record<string, unknown>[]): { runner: Runner; activity: Activity; status: string } {
  const status = join(dir, `status-${randomUUID()}.json`);
  const activity = new Activity(status);
  const open: OpenSession = () => ({
    async *[Symbol.asyncIterator]() { for (const message of messages) yield message as unknown as SDKMessage; },
    applyFlagSettings: () => Promise.resolve(),
    close: () => undefined,
  }) as ReturnType<OpenSession>;
  const runner = new Runner({ store: new SessionStore(join(dir, 'session.json'), join(dir, 'claude'), dir), open, activity, readOnly: () => false });
  return { runner, activity, status };
}

async function restarted(messages: Record<string, unknown>[]): Promise<{ dir: string; before: Activity; after: Activity; status: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'sdk-activity-restart-'));
  dirs.push(dir);
  const first = session(dir, messages);
  first.runner.start({});
  await first.runner.run();
  first.runner.close();
  const second = session(dir, []);
  second.runner.close();
  return { dir, before: first.activity, after: second.activity, status: second.status };
}

test('a helper keeps its short description after the runner restarts, never its prompt or result', async () => {
  const { dir, before, after, status } = await restarted([...observed(), { type: 'result', subtype: 'error_during_execution', is_error: true, uuid: randomUUID() }]);
  expect(before.snapshot().tasks).toEqual([expect.objectContaining({ id: TASK, description: 'check', status: 'completed' })]);
  expect(after.snapshot().tasks).toEqual([expect.objectContaining({ id: TASK, description: 'check', status: 'completed' })]);
  expect(parseRunnerActivity(JSON.parse(readFileSync(status, 'utf8')))?.tasks[0]?.description).toBe('check');
  for (const file of [join(dir, 'session.json'), status]) expect(readFileSync(file, 'utf8')).not.toMatch(/PRIVATE/);
});

test('later task descriptions are saved, and a malformed saved description fails closed', async () => {
  const updated = system({ subtype: 'task_updated', task_id: TASK, patch: { description: '  Verify\tthe schema\nPRIVATE second line' } });
  const { dir, after } = await restarted([...observed().slice(1, 3), updated]);
  expect(after.snapshot().tasks[0]?.description).toBe('Verify the schema');
  const path = join(dir, 'session.json');
  const saved = JSON.parse(readFileSync(path, 'utf8')) as { tasks: Record<string, unknown>[] };
  writeFileSync(path, JSON.stringify({ ...saved, tasks: saved.tasks.map((task) => ({ ...task, description: 'two\nlines' })) }));
  expect(() => new SessionStore(path, join(dir, 'claude'), dir).recover()).toThrow('saved Agent SDK state');
});
