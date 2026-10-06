import type { Activity } from './session.js';
import type { IconName } from '../Icon.js';

interface Mark { icon: IconName; color: 'info' | 'success' | 'danger' | null }

export const WORKER_STATE: Record<Activity['tasks'][number]['status'], Mark> = {
  pending: { icon: 'clock', color: null },
  running: { icon: 'play', color: 'info' },
  completed: { icon: 'check', color: 'success' },
  failed: { icon: 'exclamationCircle', color: 'danger' },
  stopped: { icon: 'ban', color: null },
  paused: { icon: 'pause', color: null },
  unknown: { icon: 'question', color: null },
};
