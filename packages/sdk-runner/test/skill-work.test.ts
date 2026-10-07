import { expect, test } from 'bun:test';
import { SkillWork } from '../src/skill-work.js';

const system = (work: SkillWork, subtype: string, extra: object): void => { work.observe({ type: 'system', subtype, ...extra }); };
const tool = (work: SkillWork, id: string, parent: string | null): void => {
  work.observe({ type: 'assistant', parent_tool_use_id: parent, message: { content: [{ type: 'tool_use', id }] } });
};

test.each(['completed', 'failed', 'stopped'])('terminal workers clear their outstanding child tools: %s', (status) => {
  const work = new SkillWork();
  tool(work, 'agent-tool', null);
  system(work, 'task_started', { task_id: 'worker', tool_use_id: 'agent-tool', is_backgrounded: true });
  tool(work, 'child', 'agent-tool');
  tool(work, 'nested', 'child');
  expect(work.safe).toBe(false);
  system(work, 'task_notification', { task_id: 'worker', tool_use_id: 'agent-tool', status });
  expect(work.safe).toBe(true);
});

test('background snapshots replace membership and preserve foreground tasks', () => {
  const work = new SkillWork();
  system(work, 'task_started', { task_id: 'front', is_backgrounded: false });
  system(work, 'task_started', { task_id: 'back', tool_use_id: 'agent-tool', is_backgrounded: true });
  tool(work, 'child', 'agent-tool');
  system(work, 'background_tasks_changed', { tasks: [{ task_id: 'back' }] });
  system(work, 'background_tasks_changed', { tasks: [] });
  expect(work.safe).toBe(false);
  system(work, 'task_notification', { task_id: 'front', status: 'completed' });
  expect(work.safe).toBe(true);
});

test('replacement snapshots recover missed terminal events and orphan restart bookends', () => {
  const work = new SkillWork();
  system(work, 'background_tasks_changed', { tasks: [{ task_id: 'first' }] });
  system(work, 'background_tasks_changed', { tasks: [{ task_id: 'second' }] });
  system(work, 'task_notification', { task_id: 'second', status: 'stopped', reason: 'worker_restart' });
  expect(work.safe).toBe(true);
  system(work, 'task_updated', { task_id: 'missing', patch: { description: 'not an active task' } });
  expect(work.safe).toBe(true);
});

test('an empty background snapshot cannot retire work whose background state is unknown', () => {
  const work = new SkillWork();
  system(work, 'task_started', { task_id: 'workflow' });
  system(work, 'task_updated', { task_id: 'other', patch: { status: 'running' } });
  system(work, 'background_tasks_changed', { tasks: [] });
  expect(work.safe).toBe(false);
  system(work, 'task_notification', { task_id: 'workflow', status: 'completed' });
  expect(work.safe).toBe(false);
  system(work, 'task_notification', { task_id: 'other', status: 'completed' });
  expect(work.safe).toBe(true);
});

test('task bookends preserve background membership from the preceding snapshot', () => {
  const work = new SkillWork();
  system(work, 'background_tasks_changed', { tasks: [{ task_id: 'workflow' }] });
  system(work, 'task_started', { task_id: 'workflow' });
  system(work, 'background_tasks_changed', { tasks: [] });
  expect(work.safe).toBe(true);
});

test('retiring a parent cannot hide a still-running nested task', () => {
  const work = new SkillWork();
  system(work, 'task_started', { task_id: 'parent', tool_use_id: 'parent-tool' });
  tool(work, 'child-tool', 'parent-tool');
  system(work, 'task_started', { task_id: 'child', tool_use_id: 'child-tool' });
  system(work, 'task_notification', { task_id: 'parent', status: 'completed' });
  expect(work.safe).toBe(false);
  system(work, 'task_updated', { task_id: 'child', patch: { status: 'stopped' } });
  expect(work.safe).toBe(true);
});
