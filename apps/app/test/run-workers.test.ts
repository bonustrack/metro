import { describe, expect, test } from 'bun:test';
import { WORKER_FILTERS, WORKER_STATE, workerSelection, type WorkerStatus } from '../src/components/run/worker-state.js';

const workers = WORKER_FILTERS.flatMap(({ value }) => value === 'all' ? [] : [{ id: value, status: value }]);

describe('Run worker status filter', () => {
  test('All is first and every actual task state is available', () => {
    expect(WORKER_FILTERS[0]).toEqual({ value: 'all', label: 'All' });
    expect(workers.map((worker) => worker.status).sort()).toEqual(Object.keys(WORKER_STATE).sort());
    expect(workerSelection(workers, 'all', true)).toEqual({ matching: workers, shown: workers });
  });

  test.each(workers.map((worker) => worker.status))('filters %s without changing order or other workers', (status: WorkerStatus) => {
    const rows = [...workers, { id: 'another', status }];
    const selection = workerSelection(rows, status, true);
    expect(selection.matching.map((worker) => worker.id)).toEqual([status, 'another']);
    expect(selection.shown).toEqual(selection.matching);
    expect(rows).toHaveLength(8);
  });

  test('collapsed previews and show-all use the filtered count', () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({ id: String(i), status: 'running' as const }));
    const selection = workerSelection([...workers, ...rows], 'running', false);
    expect(selection.matching).toHaveLength(6);
    expect(selection.shown.map((worker) => worker.id)).toEqual(['running', '0', '1']);
    expect(workerSelection(selection.matching, 'running', true).shown).toHaveLength(6);
  });

  test('collapse and expansion preserve the chosen status on every screen', () => {
    expect(workerSelection(workers, 'failed', false)).toEqual({ matching: [workers[3]], shown: [workers[3]] });
    expect(workerSelection(workers, 'failed', true)).toEqual({ matching: [workers[3]], shown: [workers[3]] });
  });

  test('empty filters and status changes never show unrelated workers', () => {
    const rows = [{ id: 'one', status: 'running' as WorkerStatus }];
    expect(workerSelection(rows, 'completed', true)).toEqual({ matching: [], shown: [] });
    rows[0]!.status = 'completed';
    expect(workerSelection(rows, 'running', true)).toEqual({ matching: [], shown: [] });
    expect(workerSelection(rows, 'completed', true).shown).toEqual(rows);
    expect(workerSelection([], 'all', false)).toEqual({ matching: [], shown: [] });
  });
});
