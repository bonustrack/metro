import type { ActivityCall } from '@metro-labs/client/api/connector-activity';
import { whenLabel } from '@metro-labs/client/api/when';
import { eventLabel, toolLabel } from './tool-labels.js';
import type { DotTone } from './tone.js';

const SECOND = 1_000;
const MINUTE = 60 * SECOND;

type ActivityKind = ActivityCall['kind'];

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
};

const EVENT_OUTCOMES: Record<string, OutcomeWords> = {
  delivered: { word: 'Delivered', dot: null },
  dropped_sender: { word: 'Dropped: not on the list', dot: null },
  dropped_unverified: { word: 'Dropped: sender not verified', dot: null },
  dropped_paused: { word: 'Dropped: messages paused', dot: null },
  dropped_unassigned: { word: 'Dropped: connector removed', dot: null },
  expired: { word: 'Expired', dot: null, quiet: true },
  skipped: { word: 'Events skipped', dot: null },
};

const known = (words: Record<string, OutcomeWords>, outcome: string): OutcomeWords | undefined => (Object.hasOwn(words, outcome) ? words[outcome] : undefined);

export function outcomeWords(outcome: string, kind: ActivityKind = 'call'): OutcomeWords {
  if (kind === 'event') return known(EVENT_OUTCOMES, outcome) ?? { word: 'Received', dot: null };
  return known(OUTCOMES, outcome) ?? { word: 'Ended', dot: null };
}

export const activityLabel = (call: Pick<ActivityCall, 'kind' | 'tool'>): string => (call.kind === 'event' ? eventLabel(call.tool) : toolLabel(call.tool));

export const timingWords = (call: Pick<ActivityCall, 'kind' | 'ms'>, when: string): string => (call.kind === 'event' ? when : `${durationWords(call.ms)} · ${when}`);

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
