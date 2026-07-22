import { createHmac, timingSafeEqual } from 'node:crypto';
import { asLine } from '@metro-labs/mcp/lines';
import { mintId, userSelf, type MetroEvent } from '@metro-labs/mcp/events';

export { readAccountsFile } from './accounts.js';

export function verifyLineSignature(
  channelSecret: string,
  raw: Buffer,
  header?: string,
): boolean {
  if (!header) return false;
  let given: Buffer;
  try {
    given = Buffer.from(header, 'base64');
  } catch {
    return false;
  }
  const want = createHmac('sha256', channelSecret).update(raw).digest();
  return given.length === want.length && timingSafeEqual(given, want);
}

interface LineSource {
  type?: string;
  userId?: string;
  groupId?: string;
  roomId?: string;
}

interface LineMessage {
  id?: string;
  type?: string;
  text?: string;
}

interface LineEvent {
  type?: string;
  message?: LineMessage;
  source?: LineSource;
  timestamp?: number;
}

export interface LineWebhookBody {
  destination?: string;
  events?: LineEvent[];
}

const MEDIA_PLACEHOLDER: Record<string, string> = {
  image: '[image]',
  video: '[video]',
  audio: '[audio]',
  file: '[file]',
  location: '[location]',
  sticker: '[sticker]',
};

export function messageText(message: LineMessage): string {
  if (message.type === 'text' && typeof message.text === 'string' && message.text)
    return message.text;
  return MEDIA_PLACEHOLDER[message.type ?? ''] ?? '[unsupported message]';
}

function sourceIdOf(source: LineSource): string | undefined {
  return source.groupId ?? source.roomId ?? source.userId;
}

function toEvent(accountId: string, ev: LineEvent): MetroEvent | undefined {
  if (ev.type !== 'message' || !ev.message || !ev.source) return undefined;
  const sourceId = sourceIdOf(ev.source);
  const messageId = ev.message.id;
  if (!sourceId || !messageId) return undefined;
  const isPrivate = ev.source.type === 'user';
  const senderId = ev.source.userId ?? sourceId;
  const line = asLine(`metro://line/${accountId}/${sourceId}`);
  return {
    id: mintId(),
    ts: new Date(ev.timestamp ?? Date.now()).toISOString(),
    station: 'line',
    line,
    from: asLine(`metro://line/${accountId}/user/${senderId}`),
    to: isPrivate ? userSelf() : line,
    messageId,
    text: messageText(ev.message),
    payload: { account: accountId, message_id: messageId, is_private: isPrivate },
  };
}

export function parseLineEvents(
  accountId: string,
  body: LineWebhookBody,
): MetroEvent[] {
  const events = Array.isArray(body.events) ? body.events : [];
  const out: MetroEvent[] = [];
  for (const ev of events) {
    const entry = toEvent(accountId, ev);
    if (entry) out.push(entry);
  }
  return out;
}
