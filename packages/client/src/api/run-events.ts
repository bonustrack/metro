import type { RunEvent, RunEventMetadata, RunEventsPage } from '@metro-labs/core/events';
import { daemonBase } from '../auth/daemon.js';
import { activeAccount } from '../auth/account.js';
import { isRecord } from '../read.js';
import { AuthError, call, NotFoundError } from './client.js';
import { isVersion, olderThan } from './version.js';

export type { RunEvent, RunEventMetadata, RunEventsPage } from '@metro-labs/core/events';
export const RUN_EVENTS_SINCE = '0.1.0-beta.263';
export class RunEventsUnavailableError extends Error {
  constructor() { super('Update Metro to see recent Run events.'); }
}

export interface RunEventsOptions {
  cursor?: string;
  limit?: number;
  version?: string | null;
}

const unexpected = (): Error => new Error('Metro returned an unexpected Run events response.');
const string = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max;
const optionalString = (value: unknown, max = 512): boolean => value === undefined || string(value, max);
const optionalBoolean = (value: unknown): boolean => value === undefined || typeof value === 'boolean';
const integer = (value: unknown, min: number): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= min;
const oneOf = (value: unknown, choices: string[]): boolean => typeof value === 'string' && choices.includes(value);
const time = (value: unknown): value is string => string(value, 64) && Number.isFinite(Date.parse(value));

function attachmentTypes(value: unknown): boolean {
  return value === undefined || (Array.isArray(value) && value.length <= 4 && value.every((kind: unknown) => oneOf(kind, ['image', 'video', 'audio', 'file'])));
}

const onlyKeys = (value: Record<string, unknown>, keys: string[]): boolean => Object.keys(value).every((key) => keys.includes(key));
const EVENT_KEYS = ['id', 'seq', 'ts', 'kind', 'direction', 'agentId', 'station', 'accountId', 'line', 'lineName', 'from', 'fromName', 'fromDisplayName', 'to', 'text', 'truncated', 'messageId', 'replyTo', 'metadata'];
const METADATA_KEYS = ['isPrivate', 'senderVerified', 'mentionsSelf', 'replyToSelf', 'emoji', 'removed', 'targetId', 'attachmentCount', 'attachmentTypes', 'attachmentStatus', 'attachmentFor'];

function isMetadata(value: unknown): value is RunEventMetadata {
  if (!isRecord(value) || !onlyKeys(value, METADATA_KEYS)) return false;
  return ['isPrivate', 'senderVerified', 'mentionsSelf', 'replyToSelf', 'removed'].every((key) => optionalBoolean(value[key]))
    && optionalString(value.emoji, 32)
    && ['targetId', 'attachmentFor'].every((key) => optionalString(value[key]))
    && (value.attachmentCount === undefined || integer(value.attachmentCount, 0))
    && attachmentTypes(value.attachmentTypes)
    && (value.attachmentStatus === undefined || oneOf(value.attachmentStatus, ['saved', 'failed']));
}

function identity(value: Record<string, unknown>): boolean {
  return string(value.id, 512) && integer(value.seq, 1) && time(value.ts)
    && string(value.agentId, 512) && string(value.station, 512)
    && (value.accountId === null || string(value.accountId, 2_048))
    && string(value.line, 2_048);
}

function content(value: Record<string, unknown>): boolean {
  return oneOf(value.kind, ['msg', 'reply', 'react', 'edit', 'delete', 'system'])
    && oneOf(value.direction, ['inbound', 'outbound', 'system'])
    && typeof value.truncated === 'boolean' && isMetadata(value.metadata)
    && ['lineName', 'fromName', 'fromDisplayName', 'messageId', 'replyTo'].every((key) => optionalString(value[key]))
    && optionalString(value.from, 2_048) && optionalString(value.to, 2_048) && optionalString(value.text, 8_000);
}

const isEvent = (value: unknown): value is RunEvent => isRecord(value) && onlyKeys(value, EVENT_KEYS) && identity(value) && content(value);

function isRetention(value: unknown): value is RunEventsPage['retention'] {
  return isRecord(value) && onlyKeys(value, ['capacity', 'oldestAt', 'oldestSeq']) && value.capacity === 500
    && (value.oldestAt === null || time(value.oldestAt))
    && (value.oldestSeq === null || integer(value.oldestSeq, 1));
}

function eventRows(value: unknown, agentId: string): RunEvent[] {
  if (!Array.isArray(value) || value.length > 500 || !value.every(isEvent)) throw unexpected();
  if (value.some((event, index) => event.agentId !== agentId || event.seq <= (value[index - 1]?.seq ?? 0))) throw unexpected();
  return value;
}

function pageOf(value: unknown, agentId: string): RunEventsPage {
  if (!isRecord(value) || !onlyKeys(value, ['events', 'cursor', 'hasMore', 'reset', 'retention']) || !string(value.cursor, 128) || typeof value.hasMore !== 'boolean' || typeof value.reset !== 'boolean' || !isRetention(value.retention)) throw unexpected();
  return { events: eventRows(value.events, agentId), cursor: value.cursor, hasMore: value.hasMore, reset: value.reset, retention: value.retention };
}

async function checkSupport(base: string, version: RunEventsOptions['version']): Promise<void> {
  if (olderThan(version ?? null, RUN_EVENTS_SINCE)) throw new RunEventsUnavailableError();
  if (isVersion(version)) return;
  if (activeAccount() === null) throw new AuthError('not signed in');
  const response = await fetch(`${base}/api/run/events`, { method: 'HEAD' }).catch(() => {
    throw new Error('Failed to reach Metro.');
  });
  if (response.status === 401 || response.status === 404) throw new RunEventsUnavailableError();
  if (response.status !== 405) throw new Error(`Metro returned ${response.status} while checking Run events support.`);
}

export async function getRunEvents(agentId: string, options: RunEventsOptions = {}): Promise<RunEventsPage> {
  const base = daemonBase();
  await checkSupport(base, options.version);
  const params = new URLSearchParams({ agent: agentId });
  if (options.cursor !== undefined) params.set('cursor', options.cursor);
  if (options.limit !== undefined) params.set('limit', String(options.limit));
  try {
    return pageOf(await call({ method: 'GET', base, path: `/api/run/events?${params.toString()}` }), agentId);
  } catch (err) {
    if (err instanceof NotFoundError && ['not found', 'Metro returned 404.'].includes(err.message)) throw new RunEventsUnavailableError();
    throw err;
  }
}
