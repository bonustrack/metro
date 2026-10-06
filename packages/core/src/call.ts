import { isRecord } from './is-record.js';

export const CALL_NOTICE = 'notifications/metro/call';
export const CALL_STATE = 'notifications/metro/call_state';

export interface CallState {
  route: CallRoute | null;
}

export interface CallRoute {
  agentId: string;
  line: string;
  from: string;
  callId: string;
  generation: string;
}

export interface SpeechTarget {
  callId: string;
  generation: string;
  sourceId: string;
}

export interface CallSource {
  route: CallRoute;
  sourceId: string;
}

export type SpeechStatus = 'accepted' | 'queued' | 'started' | 'completed' | 'interrupted' | 'failed';

export type CallNotice =
  | { type: 'started'; route: CallRoute; sourceId: string }
  | { type: 'heard'; route: CallRoute; sourceId: string; text: string }
  | { type: 'ended'; route: CallRoute }
  | { type: 'speech'; route: CallRoute; sourceId: string; actionId: string; status: SpeechStatus };

const filled = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 2048;

export function callRoute(value: unknown): CallRoute | null {
  if (!isRecord(value)) return null;
  const { agentId, line, from, callId, generation } = value;
  return filled(agentId) && filled(line) && filled(from) && filled(callId) && filled(generation)
    ? { agentId, line, from, callId, generation }
    : null;
}

export function callState(value: unknown): CallState | null {
  if (!isRecord(value)) return null;
  if (value.route === null) return { route: null };
  const route = callRoute(value.route);
  return route === null ? null : { route };
}

export function speechTarget(value: unknown): SpeechTarget | null {
  if (!isRecord(value)) return null;
  const { callId, generation, sourceId } = value;
  return filled(callId) && filled(generation) && filled(sourceId) ? { callId, generation, sourceId } : null;
}

const STATUSES: readonly SpeechStatus[] = ['accepted', 'queued', 'started', 'completed', 'interrupted', 'failed'];

const speechStatus = (value: unknown): SpeechStatus | null => STATUSES.find((status) => status === value) ?? null;

function sourcedNotice(value: Record<string, unknown>, route: CallRoute, sourceId: string): CallNotice | null {
  if (value.type === 'started') return { type: 'started', route, sourceId };
  if (value.type === 'heard') return typeof value.text === 'string' && value.text.length <= 32_000 ? { type: 'heard', route, sourceId, text: value.text } : null;
  if (value.type !== 'speech' || !filled(value.actionId)) return null;
  const status = speechStatus(value.status);
  return status === null ? null : { type: 'speech', route, sourceId, actionId: value.actionId, status };
}

export function callNotice(value: unknown): CallNotice | null {
  if (!isRecord(value)) return null;
  const route = callRoute(value.route);
  if (route === null) return null;
  if (value.type === 'ended') return { type: 'ended', route };
  return filled(value.sourceId) ? sourcedNotice(value, route, value.sourceId) : null;
}

export const sameCall = (a: CallRoute, b: CallRoute): boolean =>
  a.agentId === b.agentId && a.line === b.line && a.from === b.from && a.callId === b.callId && a.generation === b.generation;
