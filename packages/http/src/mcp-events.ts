import { isRecord } from '@metro-labs/core/is-record';

export const EVENTS_EXTENSION = 'io.modelcontextprotocol/events';
export const EVENTS_LIST = 'events/list';
export const EVENTS_SUBSCRIBE = 'events/subscribe';
export const EVENTS_UNSUBSCRIBE = 'events/unsubscribe';
export const EVENT_ERROR = { invalidParams: -32602, notFound: -32023, forbidden: -32024, resourceExhausted: -32025, unsupported: -32026, callbackEndpoint: -32027 } as const;
export const SENDER_META = 'box.metro/sender';
export const WEBHOOK_DELIVERY = 'webhook';
export const WEBHOOK_BODY_MAX = 256 * 1024;
export const EVENT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
export const EVENT_ID_RE = /^\P{Cc}{1,512}$/u;
export const SENDER_ID_RE = /^\P{Cc}{1,320}$/u;
export const CURSOR_MAX = 8192;
const POINTER_RE = /^(?:\/(?:[^~/]|~[01])*){1,8}$/;
const POINTER_MAX = 256;
const INDEX_RE = /^(?:0|[1-9]\d{0,8})$/;
const CHALLENGE_MAX = 1024;
const DATA_DEPTH = 32;

export interface SenderPointers {
  id: string;
  verified?: string;
}

export interface EventSender {
  id: string | null;
  verified?: boolean;
}

export interface SubscribeRequest {
  name: string;
  url: string;
  secret: string;
  cursor: string | null;
  ttlMs: number;
  maxAgeMs: number;
}

export interface SubscribeResult {
  refreshBefore: number | null;
  cursor: string | null;
  truncated: boolean;
}

export type WebhookBody =
  | { kind: 'event'; eventId: string; name: string; timestamp: string; data: Record<string, unknown>; cursor: string | null }
  | { kind: 'verification'; challenge: string }
  | { kind: 'gap'; cursor: string | null }
  | { kind: 'terminated'; code: number };

export function declaresEvents(initialize: Record<string, unknown>): boolean {
  const capabilities = isRecord(initialize.capabilities) ? initialize.capabilities : {};
  const extensions = isRecord(capabilities.extensions) ? capabilities.extensions : {};
  return isRecord(extensions[EVENTS_EXTENSION]);
}

const pointerOf = (raw: unknown): string | null => (typeof raw === 'string' && raw.length <= POINTER_MAX && POINTER_RE.test(raw) ? raw : null);

export function senderPointersOf(meta: unknown): SenderPointers | null {
  const declared = isRecord(meta) ? meta[SENDER_META] : undefined;
  if (!isRecord(declared)) return null;
  const id = pointerOf(declared.id);
  if (id === null) return null;
  const verified = pointerOf(declared.verified);
  return verified === null ? { id } : { id, verified };
}

export function pointerValue(data: unknown, pointer: string): unknown {
  let current: unknown = data;
  for (const escaped of pointer.split('/').slice(1)) {
    const key = escaped.replace(/~1/g, '/').replace(/~0/g, '~');
    if (Array.isArray(current)) {
      const items: unknown[] = current;
      current = INDEX_RE.test(key) ? items[Number(key)] : undefined;
    } else if (isRecord(current) && Object.hasOwn(current, key)) current = current[key];
    else return undefined;
  }
  return current;
}

export function eventSenderOf(pointers: SenderPointers | null, data: Record<string, unknown>): EventSender | null {
  if (pointers === null) return null;
  const raw = pointerValue(data, pointers.id);
  const id = typeof raw === 'string' && raw.trim() !== '' && SENDER_ID_RE.test(raw) ? raw.trim() : null;
  if (pointers.verified === undefined) return { id };
  return { id, verified: pointerValue(data, pointers.verified) === true };
}

export const subscribeParams = (request: SubscribeRequest): Record<string, unknown> => ({
  name: request.name,
  arguments: {},
  delivery: { mode: WEBHOOK_DELIVERY, url: request.url, secret: request.secret },
  cursor: request.cursor,
  ttlMs: request.ttlMs,
  maxAgeMs: request.maxAgeMs,
});

export const unsubscribeParams = (name: string, url: string): Record<string, unknown> => ({ name, arguments: {}, delivery: { url } });

const cursorOf = (raw: unknown): string | null => (typeof raw === 'string' && raw !== '' && raw.length <= CURSOR_MAX ? raw : null);

export function subscribeResultOf(result: Record<string, unknown>): SubscribeResult {
  const refreshBefore = typeof result.refreshBefore === 'string' ? Date.parse(result.refreshBefore) : null;
  if (Number.isNaN(refreshBefore) || (refreshBefore === null && result.refreshBefore !== null)) throw new Error('The connector answered a subscription without a time to refresh it by.');
  if (typeof result.cursor === 'string' && result.cursor.length > CURSOR_MAX) throw new Error('The connector answered a position too long to keep.');
  return { refreshBefore, cursor: cursorOf(result.cursor), truncated: result.truncated === true };
}

function controlOf(raw: Record<string, unknown>): WebhookBody | null {
  if (raw.type === 'verification') return typeof raw.challenge === 'string' && raw.challenge !== '' && raw.challenge.length <= CHALLENGE_MAX ? { kind: 'verification', challenge: raw.challenge } : null;
  if (raw.type === 'gap') return { kind: 'gap', cursor: cursorOf(raw.cursor) };
  const code = raw.type === 'terminated' && isRecord(raw.error) ? raw.error.code : undefined;
  return typeof code === 'number' && Number.isInteger(code) ? { kind: 'terminated', code } : null;
}

function nestedWithin(value: unknown, depth: number): boolean {
  if (typeof value !== 'object' || value === null) return true;
  return depth > 0 && Object.values(value).every((item) => nestedWithin(item, depth - 1));
}

function occurrenceOf(raw: Record<string, unknown>): WebhookBody | null {
  const time = typeof raw.timestamp === 'string' ? Date.parse(raw.timestamp) : Number.NaN;
  if (typeof raw.eventId !== 'string' || !EVENT_ID_RE.test(raw.eventId) || typeof raw.name !== 'string' || !EVENT_NAME_RE.test(raw.name)) return null;
  if (!Number.isFinite(time) || !isRecord(raw.data) || !nestedWithin(raw.data, DATA_DEPTH)) return null;
  return { kind: 'event', eventId: raw.eventId, name: raw.name, timestamp: new Date(time).toISOString(), data: raw.data, cursor: cursorOf(raw.cursor) };
}

export function webhookBodyOf(raw: unknown): WebhookBody | null {
  if (!isRecord(raw)) return null;
  return raw.type === undefined ? occurrenceOf(raw) : controlOf(raw);
}
