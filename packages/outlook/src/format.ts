import { bodyText } from '@metro-labs/core/stations/mail-text';
import type { MailItem } from '@metro-labs/core/stations/mail';

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

export const addressOf = (a: Address | null | undefined): string => (a?.emailAddress?.address ?? '').toLowerCase();

const addresses = (list: Address[] | undefined): string[] => (list ?? []).map(addressOf).filter((s) => s !== '');

export const itemOf = (m: GraphMessage): MailItem => ({
  id: m.id,
  threadId: m.conversationId ?? m.id,
  subject: (m.subject ?? '').trim(),
  from: addressOf(m.from),
  fromName: m.from?.emailAddress?.name ?? '',
  to: addresses(m.toRecipients),
  cc: addresses(m.ccRecipients),
  date: m.receivedDateTime ?? null,
  preview: (m.bodyPreview ?? '').trim(),
  text: bodyText(m.body),
  hasAttachments: m.hasAttachments === true,
  isRead: m.isRead === true,
  internetMessageId: m.internetMessageId ?? null,
});
