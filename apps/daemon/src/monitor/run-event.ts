import { classifyEvent, userSelf, type BufferedEvent, type MetroEvent, type RunEvent, type RunEventMetadata } from '@metro-labs/core/events';
import { isRecord } from '@metro-labs/core/is-record';
import { Line } from '@metro-labs/core/lines';
import { STATIONS } from '@metro-labs/core/station-names';
import { accountFromLine, allowlistForLine, lineReceives, senderPermitted } from '../agents/map.js';
import { eventInScope } from '../agents/scope.js';

const TEXT_MAX = 8_000;
const FIELD_MAX = 512;
const LINE_MAX = 2_048;
const ACCOUNT_STATIONS = new Set<string>(STATIONS);
const KINDS = new Set(['msg', 'reply', 'react', 'edit', 'delete', 'system']);

function safeText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  return value.slice(0, max).replace(/https?:\/\/[^\s<>"']+|\/(?:attach|api\/uploads|api\/webhooks|api\/threema)\/[^\s<>"']*/gi, (url) => /\/(?:attach|api\/uploads|api\/webhooks|api\/threema)\//i.test(url) ? '[private link]' : url).slice(0, max);
}

function validLine(line: string): boolean {
  return typeof line === 'string' && line.length <= LINE_MAX && /^metro:\/\/[a-z][a-z0-9-]*\/[^\s?#]+$/.test(line) && !line.includes('//', 8) && !line.endsWith('/');
}

const isSelf = (line: string): boolean => line === userSelf();
const isSynthetic = (payload: unknown): boolean => isRecord(payload) && (payload.contentType === 'attachmentSaved' || payload.contentType === 'attachmentFailed' || payload.contentType === 'transcript');

function sameAccount(line: string, other: string): boolean {
  if (!validLine(other)) return false;
  const a = accountFromLine(line);
  const b = accountFromLine(other);
  return a !== undefined && b !== undefined && a.station === b.station && a.accountId === b.accountId;
}

function permittedTraffic(event: MetroEvent): boolean {
  if (!isSelf(event.to) && !sameAccount(event.line, event.to)) return false;
  const allowlist = allowlistForLine(event.line);
  if (isSelf(event.from)) return !isSynthetic(event.payload) || senderPermitted(allowlist, '');
  return sameAccount(event.line, event.from) && senderPermitted(allowlist, event.from, event.senderVerified);
}

function visible(event: MetroEvent, allowed: Set<string>): boolean {
  if (!validLine(event.line) || !eventInScope(allowed, event.line) || !lineReceives(event.line)) return false;
  const station = Line.station(event.line);
  if (station !== event.station) return false;
  if (!ACCOUNT_STATIONS.has(station)) return station === 'claude' && event.event?.type === 'system' && event.isPrivate !== true;
  return permittedTraffic(event);
}

function attachmentType(value: unknown): 'image' | 'video' | 'audio' | 'file' {
  if (!isRecord(value)) return 'file';
  const mime = typeof value.mime === 'string' ? value.mime : value.contentType;
  for (const kind of ['image', 'video', 'audio'] as const) {
    if (value.kind === kind || (typeof mime === 'string' && mime.startsWith(`${kind}/`))) return kind;
  }
  return 'file';
}

function attachmentMetadata(payload: unknown): RunEventMetadata {
  if (!isRecord(payload)) return {};
  const saved = payload.contentType === 'attachmentSaved';
  const failed = payload.contentType === 'attachmentFailed';
  if (saved || failed) return {
    attachmentCount: 1,
    attachmentTypes: [attachmentType(payload)],
    attachmentStatus: saved ? 'saved' : 'failed',
    attachmentFor: safeText(payload.attachmentFor, FIELD_MAX),
  };
  if (!Array.isArray(payload.attachments) || payload.attachments.length === 0) return {};
  return {
    attachmentCount: payload.attachments.length,
    attachmentTypes: [...new Set(payload.attachments.slice(0, 100).map(attachmentType))],
  };
}

function reactionMetadata(event: MetroEvent): RunEventMetadata {
  if (event.event?.type !== 'react') return {};
  return {
    emoji: safeText(event.event.emoji, 32),
    ...(isRecord(event.payload) && typeof event.payload.removed === 'boolean' ? { removed: event.payload.removed } : {}),
  };
}

function metadata(event: MetroEvent, system: boolean): RunEventMetadata {
  const attachments = attachmentMetadata(event.payload);
  if (system) return attachments;
  const structured = event.event;
  return {
    ...attachments,
    ...(typeof event.isPrivate === 'boolean' ? { isPrivate: event.isPrivate } : {}),
    ...(typeof event.senderVerified === 'boolean' ? { senderVerified: event.senderVerified } : {}),
    ...(typeof event.mentionsSelf === 'boolean' ? { mentionsSelf: event.mentionsSelf } : {}),
    ...(typeof event.replyToSelf === 'boolean' ? { replyToSelf: event.replyToSelf } : {}),
    ...reactionMetadata(event),
    ...(structured !== undefined && 'targetId' in structured ? { targetId: safeText(structured.targetId, FIELD_MAX) } : {}),
  };
}

function messageFields(event: MetroEvent, system: boolean): Partial<RunEvent> & { truncated: boolean } {
  if (system) return { truncated: false };
  return {
    lineName: safeText(event.lineName, FIELD_MAX),
    from: safeText(event.from, LINE_MAX),
    fromName: safeText(event.fromName, FIELD_MAX),
    fromDisplayName: safeText(event.fromDisplayName, FIELD_MAX),
    to: safeText(event.to, LINE_MAX),
    text: safeText(event.text, TEXT_MAX),
    truncated: typeof event.text === 'string' && event.text.length > TEXT_MAX,
  };
}

function validIdentity(event: MetroEvent): boolean {
  return typeof event.id === 'string' && event.id.length <= FIELD_MAX
    && typeof event.ts === 'string' && event.ts.length <= 64 && Number.isFinite(Date.parse(event.ts));
}

const replyId = (event: MetroEvent): string | undefined => event.replyTo ?? (event.event?.type === 'reply' ? event.event.replyTo : undefined);
const accountId = (event: MetroEvent): string | null => ACCOUNT_STATIONS.has(event.station) ? accountFromLine(event.line)?.accountId ?? null : null;

export function runEvent(entry: BufferedEvent, agentId: string): RunEvent | null {
  const { event, busSeq } = entry;
  if (!visible(event, new Set([agentId])) || !validIdentity(event)) return null;
  const structured = event.event ?? classifyEvent(event);
  if (!KINDS.has(structured.type)) return null;
  const system = structured.type === 'system' || isSynthetic(event.payload);
  return {
    ...messageFields(event, system),
    id: safeText(event.id, FIELD_MAX) ?? '',
    seq: busSeq,
    ts: new Date(event.ts).toISOString(),
    kind: system ? 'system' : structured.type,
    direction: system ? 'system' : isSelf(event.from) ? 'outbound' : 'inbound',
    agentId,
    station: event.station,
    accountId: accountId(event),
    line: event.line,
    messageId: safeText(event.messageId, FIELD_MAX),
    replyTo: safeText(replyId(event), FIELD_MAX),
    metadata: metadata(event, system),
  };
}
