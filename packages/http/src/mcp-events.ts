import { isRecord } from '@metro-labs/core/is-record';

export const EMAIL_RECEIVED = 'email.received';
export const EVENTS_LIST = 'events/list';
export const EVENTS_SUBSCRIBE = 'events/subscribe';
export const EVENTS_UNSUBSCRIBE = 'events/unsubscribe';
export const SIGNED_OUT_CODE = -32024;

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const EVENTS_MAX = 100;
const SERVER_ID_MAX = 256;
export const CURSOR_MAX = 8192;
const EVENT_ID_MAX = 512;
const CHALLENGE_MAX = 1024;
export const MAIL_TEXT_MAX = 32 * 1024;
const SUBJECT_MAX = 998;
const ADDRESS_MAX = 320;
const NAME_MAX = 256;
const RECIPIENTS_MAX = 100;
const FILES_MAX = 50;
const FILE_NAME_MAX = 256;
const MIME_MAX = 128;
const URL_MAX = 2048;
const ID_MAX = 1024;

export interface RemoteEvent {
  name: string;
  delivery: string[];
}

export interface SubscribeAnswer {
  id: string;
  refreshBefore: number | null;
  cursor: string | null;
  truncated: boolean;
  delivering: boolean;
  lastError: string | null;
}

export interface MailFile {
  name: string;
  mime: string;
  size: number;
  url: string | null;
}

export interface EmailReceived {
  messageId: string;
  threadId: string;
  from: { address: string; name?: string };
  to: string[];
  cc: string[];
  subject: string;
  receivedAt: string;
  text: string;
  senderVerified: boolean;
  attachments: MailFile[];
}

export type WebhookBody =
  | { type: 'event'; eventId: string; name: string; data: unknown; cursor: string | null }
  | { type: 'verification'; challenge: string }
  | { type: 'gap'; cursor: string | null }
  | { type: 'terminated'; reason: string; signedOut: boolean }
  | { type: 'other' };

export function declaresEvents(init: Record<string, unknown>): boolean {
  const capabilities = isRecord(init.capabilities) ? init.capabilities : {};
  const experimental = isRecord(capabilities.experimental) ? capabilities.experimental : {};
  return isRecord(capabilities.events) || isRecord(experimental.events);
}

function eventOf(raw: unknown): RemoteEvent | null {
  if (!isRecord(raw) || typeof raw.name !== 'string' || !NAME_RE.test(raw.name)) return null;
  const delivery = Array.isArray(raw.delivery) ? raw.delivery.filter((mode): mode is string => mode === 'webhook' || mode === 'poll' || mode === 'push') : [];
  return { name: raw.name, delivery: [...new Set(delivery)] };
}

export function eventsPageOf(result: Record<string, unknown> | null): { events: RemoteEvent[]; next: string | null } {
  const events = result !== null && Array.isArray(result.events) ? result.events.map(eventOf).filter((event): event is RemoteEvent => event !== null).slice(0, EVENTS_MAX) : [];
  const next = result?.nextCursor;
  return { events, next: typeof next === 'string' && next !== '' ? next : null };
}

export const webhookEventNames = (events: RemoteEvent[]): string[] => events.filter((event) => event.delivery.includes('webhook')).map((event) => event.name);

export const deliversMail = (events: RemoteEvent[]): boolean => webhookEventNames(events).includes(EMAIL_RECEIVED);

const capped = (value: unknown, max: number): string | null => (typeof value === 'string' && value.length > 0 && value.length <= max ? value : null);

function grantOf(value: unknown): number | null | undefined {
  if (value === null) return null;
  if (typeof value !== 'string') return undefined;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : undefined;
}

export function subscribeAnswerOf(result: Record<string, unknown>): SubscribeAnswer {
  const id = capped(result.id, SERVER_ID_MAX);
  const refreshBefore = grantOf(result.refreshBefore);
  if (id === null || refreshBefore === undefined) throw new Error('The connector answered events/subscribe without a subscription id and refreshBefore.');
  const status = isRecord(result.deliveryStatus) ? result.deliveryStatus : {};
  return { id, refreshBefore, cursor: capped(result.cursor, CURSOR_MAX), truncated: result.truncated === true, delivering: status.active !== false, lastError: capped(status.lastError, 64) };
}

const cursorOf = (value: unknown): string | null => capped(value, CURSOR_MAX);

function controlOf(raw: Record<string, unknown>): WebhookBody {
  if (raw.type === 'verification') {
    const challenge = capped(raw.challenge, CHALLENGE_MAX);
    return challenge === null ? { type: 'other' } : { type: 'verification', challenge };
  }
  if (raw.type === 'gap') return { type: 'gap', cursor: cursorOf(raw.cursor) };
  if (raw.type === 'terminated') {
    const error = isRecord(raw.error) ? raw.error : {};
    const data = isRecord(error.data) ? error.data : {};
    return { type: 'terminated', reason: typeof error.message === 'string' ? error.message.slice(0, 300) : 'the connector ended the subscription', signedOut: error.code === SIGNED_OUT_CODE || data.reason === 'signed_out' };
  }
  return { type: 'other' };
}

export function webhookBodyOf(raw: unknown): WebhookBody | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.type === 'string') return controlOf(raw);
  const eventId = capped(raw.eventId, EVENT_ID_MAX);
  if (eventId === null || typeof raw.name !== 'string') return null;
  return { type: 'event', eventId, name: raw.name, data: raw.data, cursor: cursorOf(raw.cursor) };
}

const ADDRESS_RE = /^[^@\s<>/?#"]+@[^@\s<>/?#"]+$/;

const addressOf = (value: unknown): string | null => {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return text.length <= ADDRESS_MAX && ADDRESS_RE.test(text) ? text : null;
};

const addressesOf = (value: unknown): string[] => (Array.isArray(value) ? value.map(addressOf).filter((address): address is string => address !== null).slice(0, RECIPIENTS_MAX) : []);

function httpsUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > URL_MAX) return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && url.username === '' && url.password === '' ? url.toString() : null;
  } catch {
    return null;
  }
}

const filledOr = (value: unknown, max: number, fallback: string): string => (typeof value === 'string' && value.trim() !== '' ? value.trim().slice(0, max) : fallback);

const sizeOf = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : 0);

function fileOf(raw: unknown): MailFile | null {
  if (!isRecord(raw)) return null;
  return { name: filledOr(raw.name, FILE_NAME_MAX, 'attachment'), mime: filledOr(raw.mime, MIME_MAX, 'application/octet-stream'), size: sizeOf(raw.size), url: httpsUrl(raw.url) };
}

function senderOf(raw: unknown): EmailReceived['from'] | null {
  if (!isRecord(raw)) return null;
  const address = addressOf(raw.address);
  if (address === null) return null;
  const name = typeof raw.name === 'string' ? raw.name.replace(/\p{Cc}/gu, ' ').trim().slice(0, NAME_MAX) : '';
  return name === '' ? { address } : { address, name };
}

export function emailReceivedOf(raw: unknown): EmailReceived | null {
  if (!isRecord(raw)) return null;
  const messageId = capped(raw.messageId, ID_MAX);
  const threadId = capped(raw.threadId, ID_MAX);
  const from = senderOf(raw.from);
  if (messageId === null || threadId === null || from === null) return null;
  const receivedAt = typeof raw.receivedAt === 'string' && Number.isFinite(Date.parse(raw.receivedAt)) ? new Date(raw.receivedAt).toISOString() : new Date().toISOString();
  const attachments = Array.isArray(raw.attachments) ? raw.attachments.map(fileOf).filter((file): file is MailFile => file !== null).slice(0, FILES_MAX) : [];
  return {
    messageId,
    threadId,
    from,
    to: addressesOf(raw.to),
    cc: addressesOf(raw.cc),
    subject: typeof raw.subject === 'string' ? raw.subject.replace(/[\r\n]+/g, ' ').trim().slice(0, SUBJECT_MAX) : '',
    receivedAt,
    text: typeof raw.text === 'string' ? raw.text.slice(0, MAIL_TEXT_MAX) : '',
    senderVerified: raw.senderVerified === true,
    attachments,
  };
}
