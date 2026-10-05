import type { RunEvent, RunEventsPage } from '@metro-labs/client/api/run-events';
import type { RunEntry } from './model.js';

export interface RetainedRunFeed extends RunEventsPage { generation: number }

export function mergeRunFeed(previous: RetainedRunFeed | undefined, page: RunEventsPage): RetainedRunFeed {
  const oldest = page.retention.oldestSeq;
  const retained = page.reset || oldest === null ? [] : (previous?.events ?? []).filter((event) => event.seq >= oldest);
  const rows = new Map(retained.map((event) => [event.seq, event]));
  for (const event of page.events) rows.set(event.seq, event);
  return {
    ...page, events: [...rows.values()].sort((a, b) => a.seq - b.seq).slice(-500),
    generation: (previous?.generation ?? 0) + (page.reset ? 1 : 0),
  };
}

function reactionText(event: RunEvent): string {
  return `${event.metadata.removed === true ? 'Reaction removed' : 'Message reaction'}${event.metadata.emoji === undefined ? '.' : `: ${event.metadata.emoji}`}`;
}

function attachmentText(count: number): string {
  return count > 0 ? `${String(count)} attachment${count === 1 ? '' : 's'}. Media is not loaded here.` : 'No text in this event.';
}

function eventText(event: RunEvent): string {
  if (event.metadata.attachmentStatus !== undefined) return `Attachment ${event.metadata.attachmentStatus}.`;
  if (event.kind === 'system') return 'Metro system event. Its body is not exposed in this view.';
  if (event.kind === 'delete') return 'Message deleted.';
  if (event.kind === 'react') return reactionText(event);
  return event.text !== undefined && event.text !== '' ? event.text : attachmentText(event.metadata.attachmentCount ?? 0);
}

function eventMetadata(event: RunEvent): [string, string][] {
  const rows: [string, string][] = [['Metro kind', event.kind], ['Agent ID', event.agentId]];
  if (event.messageId !== undefined) rows.push(['Message ID', event.messageId]);
  if (event.replyTo !== undefined) rows.push(['Reply to', event.replyTo]);
  if (event.to !== undefined) rows.push(['To', event.to]);
  for (const key of ['isPrivate', 'senderVerified', 'mentionsSelf', 'replyToSelf', 'emoji', 'removed', 'targetId', 'attachmentCount', 'attachmentTypes', 'attachmentStatus', 'attachmentFor'] as const) {
    const value = event.metadata[key];
    if (value !== undefined) rows.push([key, Array.isArray(value) ? value.join(', ') : String(value)]);
  }
  return rows;
}

function identity(event: RunEvent, agentName: string): { sender: string; senderId: string } {
  if (event.direction === 'outbound') return { sender: agentName, senderId: event.agentId };
  return { sender: event.fromDisplayName ?? event.fromName ?? event.from ?? 'Metro', senderId: event.from ?? `${event.station}:system` };
}

function eventStatus(event: RunEvent): string {
  if (event.metadata.attachmentStatus === 'failed') return 'Failed';
  if (event.kind === 'edit') return 'Edited';
  if (event.direction === 'system') return 'Observed';
  return event.direction === 'outbound' ? 'Sent' : 'Received';
}

export function metroEntry(event: RunEvent, agentName: string): RunEntry {
  const { sender, senderId } = identity(event, agentName);
  const message = ['msg', 'reply', 'edit'].includes(event.kind) && event.direction !== 'system';
  const failed = event.metadata.attachmentStatus === 'failed';
  return {
    id: `metro-${String(event.seq)}-${event.id}`, at: Date.parse(event.ts), kind: failed ? 'Error' : message ? 'Message' : 'System',
    title: message ? `Message from ${sender}` : event.kind === 'system' ? 'Metro system event' : event.kind,
    text: eventText(event), sender, senderId,
    station: event.station, account: event.accountId ?? '', channel: event.lineName ?? event.line.split('/').slice(4).join('/'), line: event.line,
    direction: event.direction, status: eventStatus(event),
    worker: 'Unlinked', session: null, messageId: event.messageId, replyTo: event.replyTo, truncated: event.truncated, metadata: eventMetadata(event),
  };
}
