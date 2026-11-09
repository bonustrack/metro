import type { ActivityCall } from '@metro-labs/client/api/connector-activity';
import { whenLabel } from '@metro-labs/client/api/when';
import type { DotTone } from './tone.js';
import { toolLabel } from './tool-labels.js';

const SECOND = 1_000;
const MINUTE = 60 * SECOND;

interface OutcomeWords {
  word: string;
  dot: DotTone | null;
  quiet?: true;
}

const OUTCOMES: Record<string, OutcomeWords> = {
  ok: { word: 'Done', dot: null },
  needs_approval: { word: 'Waiting for approval', dot: null },
  vendor_error: { word: 'Failed', dot: 'danger' },
  unavailable: { word: 'Could not reach it', dot: 'danger' },
  signin: { word: 'Needs a new sign-in', dot: 'danger' },
  blocked: { word: 'Blocked', dot: 'danger' },
  denied: { word: 'Denied', dot: 'danger' },
  not_found: { word: 'No such tool', dot: 'danger' },
  invalid: { word: 'Not a valid call', dot: 'danger' },
  delivered: { word: 'Delivered', dot: null },
  dropped_sender: { word: 'Dropped: not in People', dot: null },
  dropped_unverified: { word: 'Dropped: sender not verified', dot: null },
  dropped_off: { word: 'Dropped: Receive messages is off', dot: null },
  dropped_paused: { word: 'Dropped: messages paused', dot: null },
  expired: { word: 'Expired', dot: null, quiet: true },
};

export const callTitle = (call: Pick<ActivityCall, 'kind' | 'tool'>): string => (call.kind === 'received' ? 'Received an email' : toolLabel(call.tool));

export const outcomeWords = (outcome: string): OutcomeWords => OUTCOMES[outcome] ?? { word: 'Ended', dot: null };

export function durationWords(ms: number): string {
  if (ms < SECOND) return `${String(Math.round(ms))} ms`;
  if (ms < 10 * SECOND) return `${(ms / SECOND).toFixed(1)} s`;
  if (ms < MINUTE) return `${String(Math.round(ms / SECOND))} s`;
  const minutes = Math.floor(ms / MINUTE);
  const seconds = Math.round((ms - minutes * MINUTE) / SECOND);
  return seconds === 0 ? `${String(minutes)} min` : `${String(minutes)} min ${String(seconds)} s`;
}

export function agoWords(at: number, now: number): string {
  const ago = now - at;
  if (ago < 2 * SECOND) return 'just now';
  if (ago < MINUTE) return `${String(Math.floor(ago / SECOND))} s ago`;
  return whenLabel(new Date(at).toISOString(), now);
}
