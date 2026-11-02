import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { log } from '@metro-labs/core/log';
import { TaskLedger } from '../src/task-ledger.ts';
import { pendingNotice, TASK_LIMIT, type SavedTask } from '../src/task-state.ts';

const NOW = 1_800_000_000_000;
const started = (id: string): Record<string, unknown> => ({ type: 'system', subtype: 'task_started', task_id: id, tool_use_id: `launch-${id}`, task_type: 'local_agent', uuid: randomUUID() });

const row = (i: number, deliveries: number | null, state: SavedTask['state'] = 'failed'): SavedTask => ({
  id: `worker-${String(i)}`,
  toolUseId: null,
  owner: 'main',
  attempt: 1,
  state,
  events: [],
  updatedAt: NOW + i,
  notice: deliveries === null ? null : { ...pendingNotice('task_error', 1, NOW), deliveries, consumed: deliveries > 0 },
});

const full = (make: (i: number) => SavedTask): SavedTask[] => Array.from({ length: TASK_LIMIT }, (_, i) => make(i));

let warn: ReturnType<typeof spyOn<typeof log, 'warn'>>;
beforeEach(() => { warn = spyOn(log, 'warn'); });
afterEach(() => { warn.mockRestore(); });

describe('a full task ledger never ends the session', () => {
  test('a ledger full of notices already delivered three times drops the oldest one for a new worker', () => {
    const saved: SavedTask[][] = [];
    const ledger = new TaskLedger(full((i) => row(i, 3)), (tasks) => { saved.push(tasks); });
    expect(() => { ledger.observe(started('new'), NOW + 1_000); }).not.toThrow();
    const ids = ledger.snapshot().map((task) => task.id);
    expect(ids).toHaveLength(TASK_LIMIT);
    expect(ids).toContain('new');
    expect(ids).not.toContain('worker-0');
    expect(ledger.snapshot().find((task) => task.id === 'new')?.state).toBe('running');
    expect(saved.at(-1)?.some((task) => task.id === 'new')).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  test('a finished row with no notice still goes first', () => {
    const ledger = new TaskLedger(full((i) => row(i, i === 150 ? null : 3)), () => undefined);
    ledger.observe(started('new'), NOW + 1_000);
    const ids = ledger.snapshot().map((task) => task.id);
    expect(ids).not.toContain('worker-150');
    expect(ids).toContain('worker-0');
  });

  test('notices still being delivered, or running work, are kept: the new worker runs untracked and it is logged once', () => {
    const ledger = new TaskLedger(full((i) => (i % 2 === 0 ? row(i, 1) : row(i, null, 'running'))), () => undefined);
    expect(() => {
      ledger.observe(started('new'), NOW + 1_000);
      ledger.observe(started('newer'), NOW + 2_000);
    }).not.toThrow();
    const ids = ledger.snapshot().map((task) => task.id);
    expect(ids).toHaveLength(TASK_LIMIT);
    expect(ids).not.toContain('new');
    expect(ids).toContain('worker-0');
    expect(warn.mock.calls.filter((call) => String(call[1]).includes('task ledger is full'))).toHaveLength(1);
  });

  test('a notice waiting on a delivery is not dropped even after three deliveries', () => {
    const offered = full((i) => row(i, 3));
    for (const task of offered) if (task.notice !== null) task.notice.offered = randomUUID();
    const ledger = new TaskLedger(offered, () => undefined);
    ledger.observe(started('new'), NOW + 1_000);
    expect(ledger.snapshot().map((task) => task.id)).not.toContain('new');
  });
});
