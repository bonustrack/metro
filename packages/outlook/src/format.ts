import { Line } from '@metro-labs/core/lines';
import { mintId } from '@metro-labs/core/stations/station-runtime';
import { bodyText, capText } from './html.js';

export interface Address {
  emailAddress?: { name?: string; address?: string };
}

export interface GraphMessage {
  id: string;
  conversationId?: string;
  subject?: string | null;
  from?: Address | null;
  toRecipients?: Address[];
  ccRecipients?: Address[];
  receivedDateTime?: string;
  bodyPreview?: string;
  body?: { contentType?: string; content?: string };
  hasAttachments?: boolean;
  isRead?: boolean;
  internetMessageId?: string;
  '@removed'?: unknown;
}

export const MESSAGE_FIELDS = [
  'id',
  'conversationId',
  'subject',
  'from',
  'toRecipients',
  'ccRecipients',
  'receivedDateTime',
  'bodyPreview',
  'body',
  'hasAttachments',
  'isRead',
  'internetMessageId',
].join(',');

export const LIST_FIELDS = MESSAGE_FIELDS.replace(',body,', ',');

const encodeResource = (id: string): string => id.replace(/%/g, '%25').replace(/\//g, '%2F').replace(/\+/g, '%2B');

export const lineOf = (accountId: string, conversationId: string): string =>
  `metro://outlook/${accountId}/${encodeResource(conversationId)}`;

export const userOf = (accountId: string, address: string): string =>
  `metro://outlook/${accountId}/user/${address.toLowerCase()}`;

export function conversationOfLine(line: string): { accountId: string; conversationId: string } | null {
  const parsed = Line.parseOutlook(line);
  if (parsed === null) return null;
  try {
    return { accountId: parsed.accountId, conversationId: decodeURIComponent(parsed.resource) };
  } catch {
    return null;
  }
}

export const addressOf = (a: Address | null | undefined): string => (a?.emailAddress?.address ?? '').toLowerCase();
export const nameOf = (a: Address | null | undefined): string => a?.emailAddress?.name ?? '';

const addresses = (list: Address[] | undefined): string[] => (list ?? []).map(addressOf).filter((s) => s !== '');

export const titleOf = (m: GraphMessage): string => (m.subject ?? '').trim();

export function messageText(m: GraphMessage): string {
  const title = titleOf(m);
  const body = capText(bodyText(m.body));
  return title === '' ? body : `Subject: ${title}\n\n${body}`;
}

export function isPrivateTo(m: GraphMessage, self: string): boolean {
  const to = addresses(m.toRecipients);
  return to.length === 1 && to[0] === self && addresses(m.ccRecipients).length === 0;
}

export interface AttachmentMeta {
  kind: string;
  name: string;
  mime: string;
  size?: number;
}

export function inboundEnvelope(accountId: string, self: string, m: GraphMessage, attachments: AttachmentMeta[], verified: boolean): Record<string, unknown> {
  const from = addressOf(m.from);
  const title = titleOf(m);
  return {
    id: mintId(),
    ts: m.receivedDateTime ?? new Date().toISOString(),
    station: 'outlook',
    line: lineOf(accountId, m.conversationId ?? m.id),
    line_name: title === '' ? '(no subject)' : title,
    from: userOf(accountId, from === '' ? 'unknown' : from),
    from_name: nameOf(m.from) || from,
    from_display_name: nameOf(m.from) || undefined,
    message_id: m.id,
    text: messageText(m),
    is_private: isPrivateTo(m, self),
    sender_verified: verified,
    payload: {
      from,
      to: addresses(m.toRecipients),
      cc: addresses(m.ccRecipients),
      subject: title,
      internetMessageId: m.internetMessageId ?? null,
      ...(attachments.length === 0 ? {} : { attachments }),
    },
  };
}

export function summaryOf(accountId: string, m: GraphMessage): Record<string, unknown> {
  return {
    message_id: m.id,
    line: lineOf(accountId, m.conversationId ?? m.id),
    from: addressOf(m.from),
    from_name: nameOf(m.from),
    date: m.receivedDateTime ?? null,
    title: titleOf(m),
    text_preview: (m.bodyPreview ?? '').trim(),
    has_attachments: m.hasAttachments === true,
    is_read: m.isRead === true,
  };
}

export function fullOf(accountId: string, m: GraphMessage): Record<string, unknown> {
  return {
    message_id: m.id,
    line: lineOf(accountId, m.conversationId ?? m.id),
    from: addressOf(m.from),
    from_name: nameOf(m.from),
    date: m.receivedDateTime ?? null,
    title: titleOf(m),
    has_attachments: m.hasAttachments === true,
    is_read: m.isRead === true,
    to: addresses(m.toRecipients),
    cc: addresses(m.ccRecipients),
    text: capText(bodyText(m.body)),
  };
}
