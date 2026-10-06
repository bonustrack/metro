import type { Activity } from './session.js';
import type { IconName } from '../Icon.js';

export type WorkerStatus = Activity['tasks'][number]['status'];
export type WorkerFilter = 'all' | WorkerStatus;
interface Mark { icon: IconName; color: 'info' | 'success' | 'danger' | null }

export const WORKER_FILTERS = [
  { value: 'all', label: 'All' }, { value: 'pending', label: 'Pending' },
  { value: 'running', label: 'Running' }, { value: 'completed', label: 'Completed' },
  { value: 'failed', label: 'Failed' }, { value: 'stopped', label: 'Stopped' },
  { value: 'paused', label: 'Paused' }, { value: 'unknown', label: 'Unknown' },
] as const;

export function workerSelection<T extends { status: WorkerStatus }>(workers: T[], filter: WorkerFilter, expanded: boolean, narrow: boolean): { matching: T[]; shown: T[] } {
  const matching = filter === 'all' ? workers : workers.filter((worker) => worker.status === filter);
  return { matching, shown: expanded ? matching : narrow ? [] : matching.slice(0, 3) };
}

export const WORKER_STATE: Record<WorkerStatus, Mark> = {
  pending: { icon: 'clock', color: null },
  running: { icon: 'play', color: 'info' },
  completed: { icon: 'check', color: 'success' },
  failed: { icon: 'exclamationCircle', color: 'danger' },
  stopped: { icon: 'ban', color: null },
  paused: { icon: 'pause', color: null },
  unknown: { icon: 'question', color: null },
};
