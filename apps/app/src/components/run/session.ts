import type { ClaudeSessionStatus } from '@metro-labs/client/api/claude-box';
import { activityIsStale } from '@metro-labs/client/api/runner';
import { activityView, runnerEventLabel, runnerFailureSummary } from '@metro-labs/client/api/runner-activity';
import type { EntryKind, RunEntry } from './model.js';

export type Activity = NonNullable<ClaudeSessionStatus['activity']>;
type Event = Activity['events'][number];
export type Freshness = 'Fresh' | 'Stale' | 'Disconnected' | 'Stopped' | 'Unsupported' | 'Waiting for status' | 'Loading';

export function freshness(status: ClaudeSessionStatus | undefined, now: number, disconnected: boolean): Freshness {
  if (disconnected) return 'Disconnected';
  if (status === undefined) return 'Loading';
  if (!status.running || status.activity?.phase === 'stopped') return 'Stopped';
  if (status.runner !== 'sdk') return 'Unsupported';
  if (status.activity === null) return 'Waiting for status';
  return activityIsStale(status.activity.updatedAt, now) ? 'Stale' : 'Fresh';
}

export function sessionView(status: ClaudeSessionStatus, now: number, disconnected: boolean): ReturnType<typeof activityView> | null {
  return status.activity === null ? null : activityView(disconnected ? { ...status, running: false } : status, status.activity, now);
}

export const sessionIdentity = (activity: Activity): string => activity.sessionId ?? `Process ${String(activity.pid)}:${activity.procStart ?? 'unknown'}`;

function kindOf(event: Event): EntryKind {
  if (event.code !== undefined || event.kind.endsWith('_failed')) return 'Error';
  if (event.kind.startsWith('tool_')) return 'Tool';
  if (event.kind.startsWith('task_')) return 'Worker';
  if (event.kind.startsWith('approval_') || event.kind === 'permission_denied') return 'Approval';
  return 'System';
}

const mainEvent = (event: Event): boolean => event.taskId === null && event.tool === null && event.toolUseId === undefined;

function mainTurnRecovered(event: Event, activity: Activity): boolean {
  return event.kind === 'turn_failed' && mainEvent(event)
    && activity.events.some((later) => later.kind === 'turn_finished' && mainEvent(later) && later.at > event.at);
}

function failureStatus(event: Event, activity: Activity, live: boolean): string {
  if (event.id === undefined) return 'Past error';
  if (event.id === activity.activeFailure?.id) return live ? 'Failed' : 'Failed at last report';
  if (event.id === activity.lastFailure?.id && activity.activeFailure === null && mainTurnRecovered(event, activity)) return 'Resolved';
  return 'Past error';
}

function statusOf(event: Event, activity: Activity, live: boolean): string {
  if (kindOf(event) === 'Error') return failureStatus(event, activity, live);
  if (event.kind.endsWith('_finished') || event.kind.endsWith('_completed') || event.kind === 'compacted') return 'Completed';
  if (event.kind === 'permission_denied') return 'Denied';
  if (event.kind.endsWith('_stopped')) return 'Stopped';
  const active = event.toolUseId !== undefined && activity.activeTools.some((tool) => tool.id === event.toolUseId);
  return active ? live ? 'Running' : 'Last observed' : 'Observed';
}

function eventMetadata(event: Event): [string, string][] {
  const metadata: [string, string][] = [['SDK event', event.kind], ['Task ID', event.taskId ?? 'Not linked']];
  if (event.toolUseId !== undefined) metadata.push(['Tool call ID', event.toolUseId]);
  if (event.code !== undefined) metadata.push(['Failure code', event.code]);
  return metadata;
}

function eventSender(event: Event, activity: Activity, worker: string): string {
  const task = activity.tasks.find((row) => row.id === event.taskId);
  if (task?.agent !== undefined && task.agent !== null) return task.agent;
  if (event.taskId !== null) return `Worker ${event.taskId}`;
  return worker === 'Main' ? 'Main session' : 'SDK session';
}

function eventId(event: Event, occurrences: Map<string, number>): string {
  if (event.id !== undefined) return encodeURIComponent(event.id);
  const key = encodeURIComponent(JSON.stringify([event.at, event.kind, event.tool, event.toolUseId, event.taskId, event.code]));
  const occurrence = occurrences.get(key) ?? 0;
  occurrences.set(key, occurrence + 1);
  return `legacy-${key}-${String(occurrence)}`;
}

function sdkEntry(event: Event, id: string, activity: Activity, live: boolean): RunEntry {
  const title = runnerEventLabel(event.kind);
  const worker = event.taskId ?? (event.kind.startsWith('turn_') ? 'Main' : 'Unlinked');
  const state = statusOf(event, activity, live);
  const summary = event.code === undefined ? [title, event.tool].filter(Boolean).join(' · ') : runnerFailureSummary(event.code, event.tool);
  return {
    id: `sdk-${encodeURIComponent(sessionIdentity(activity))}-${id}`,
    at: event.at, kind: kindOf(event), title, text: state === 'Resolved' ? `${summary} A later main turn completed successfully in this session.` : summary,
    sender: eventSender(event, activity, worker),
    senderId: event.taskId ?? 'sdk-session', station: 'Agent SDK', account: '', channel: '', line: '', direction: 'system', status: state,
    worker, session: sessionIdentity(activity), toolUseId: event.toolUseId, truncated: false, metadata: eventMetadata(event),
  };
}

export function sdkEntries(status: ClaudeSessionStatus | undefined, now: number, disconnected: boolean): RunEntry[] {
  const activity = status?.activity;
  if (activity === null || activity === undefined) return [];
  const events = [...activity.events];
  for (const failure of [activity.activeFailure, activity.lastFailure]) {
    if (failure && !events.some((event) => event.id === failure.id)) events.push(failure);
  }
  const live = freshness(status, now, disconnected) === 'Fresh';
  const occurrences = new Map<string, number>();
  return events.slice(0, 42).reverse().map((event) => sdkEntry(event, eventId(event, occurrences), activity, live)).reverse();
}
