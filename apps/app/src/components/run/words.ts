import { stationLabel } from '@metro-labs/client/api/attach';
import { whenLabel } from '@metro-labs/client/api/when';
import type { Freshness } from './session.js';
import type { WorkerStatus } from './worker-state.js';
import { clock, short, type RunEntry } from './model.js';

export const FRESHNESS_WORD: Record<Freshness, string> = {
  Fresh: 'Live',
  Stale: 'Not updated lately',
  Disconnected: 'Not connected',
  Stopped: 'Stopped',
  Unsupported: 'Not available',
  'Waiting for status': 'Starting',
  Loading: 'Loading',
};

export const TASK_WORD: Record<WorkerStatus, string> = {
  pending: 'Waiting to start',
  running: 'Working',
  completed: 'Done',
  failed: 'Failed',
  stopped: 'Stopped',
  paused: 'Paused',
  unknown: 'Not known',
};

const STATUS_WORD: Record<string, string> = {
  Observed: 'Seen',
  'Last observed': 'Last seen',
  Running: 'Working',
  Completed: 'Done',
  'Past error': 'Earlier problem',
  'Failed at last report': 'Failed',
  Resolved: 'Fixed',
  Denied: 'Not allowed',
};

export const statusWord = (status: string, technical: boolean): string => (technical ? status : (STATUS_WORD[status] ?? status));

export function entryTime(at: number, technical: boolean, now = Date.now()): string {
  if (technical) return clock(at);
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? '' : whenLabel(date.toISOString(), now);
}

export function entryPlace(entry: RunEntry, technical: boolean): string {
  if (technical) return [entry.station, short(entry.account, 20), short(entry.channel, 40)].filter((part) => part !== '').join(' · ');
  return [stationLabel(entry.station), short(entry.channel, 40)].filter((part) => part !== '').join(' · ');
}

const IDENTIFIER = /^[A-Za-z0-9_.:-]+$/;
const sdkEntry = (entry: RunEntry): boolean => entry.station === 'Agent SDK';

export function entrySender(entry: RunEntry, technical: boolean): string {
  if (technical || !sdkEntry(entry)) return entry.sender;
  if (entry.worker === 'Main') return 'Main thread';
  return entry.worker === 'Unlinked' ? 'The agent' : 'A worker';
}

export function entryText(entry: RunEntry, technical: boolean): string {
  if (technical || !sdkEntry(entry)) return entry.text;
  return entry.text.split(' · ').filter((part) => !(IDENTIFIER.test(part) && /[_.:]/.test(part))).join(' · ');
}
