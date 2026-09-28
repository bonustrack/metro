import { kindOf } from '@metro-labs/core/stations/attachments';
import type { AttachmentMeta, MailItem } from '@metro-labs/core/stations/mail';
import { decodeEntities, htmlToText, tidy } from '@metro-labs/core/stations/mail-text';
import { firstHeader, type MailHeader } from '@metro-labs/core/stations/mail-trust';

export interface GmailPart {
  mimeType?: string;
  filename?: string;
  headers?: MailHeader[];
  body?: { attachmentId?: string; size?: number; data?: string };
  parts?: GmailPart[];
}

export interface GmailMessage {
  id: string;
  threadId?: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: GmailPart;
}

export interface MailFile extends AttachmentMeta {
  attachmentId: string | null;
  data: string | null;
}

export interface Person {
  address: string;
  name: string;
}

export const LIST_HEADERS = ['From', 'To', 'Cc', 'Subject', 'Message-ID'];

export const headersOf = (m: GmailMessage): MailHeader[] => m.payload?.headers ?? [];

export const headerOf = (m: GmailMessage, name: string): string => firstHeader(headersOf(m), name.toLowerCase()) ?? '';

const splitList = (value: string): string[] =>
  (value.match(/(?:"(?:[^"\\]|\\.)*"|<[^>]*>|[^,"<])+/g) ?? []).map((s) => s.trim()).filter((s) => s !== '');

export function personOf(raw: string): Person {
  const angle = /<([^<>]*)>\s*$/.exec(raw);
  if (angle === null) return { address: raw.replace(/\([^()]*\)/g, '').trim().toLowerCase(), name: '' };
  const name = raw.slice(0, angle.index).trim().replace(/^"(.*)"$/, '$1').replace(/\\(.)/g, '$1');
  return { address: (angle[1] ?? '').trim().toLowerCase(), name };
}

export const peopleOf = (value: string): Person[] => splitList(value).map(personOf).filter((p) => p.address.includes('@'));

const addressesOf = (value: string): string[] => peopleOf(value).map((p) => p.address);

function flatten(part: GmailPart | undefined): GmailPart[] {
  return part === undefined ? [] : [part, ...(part.parts ?? []).flatMap(flatten)];
}

const isFile = (p: GmailPart): boolean => (p.filename ?? '') !== '';

function charsetOf(part: GmailPart): string {
  const type = firstHeader(part.headers ?? [], 'content-type') ?? '';
  return /charset="?([^";\s]+)/i.exec(type)?.[1] ?? 'utf-8';
}

function decoded(part: GmailPart): string {
  const bytes = Buffer.from(part.body?.data ?? '', 'base64url');
  try {
    return new TextDecoder(charsetOf(part)).decode(bytes);
  } catch {
    return bytes.toString('utf8');
  }
}

export const unloadedBodies = (m: GmailMessage): GmailPart[] =>
  flatten(m.payload).filter((p) => !isFile(p) && (p.mimeType ?? '').startsWith('text/') && (p.body?.data ?? '') === '' && (p.body?.attachmentId ?? '') !== '');

export function textOf(m: GmailMessage): string {
  const parts = flatten(m.payload).filter((p) => !isFile(p) && (p.body?.data ?? '') !== '');
  const plain = parts.find((p) => p.mimeType === 'text/plain');
  if (plain !== undefined) return tidy(decoded(plain));
  const html = parts.find((p) => p.mimeType === 'text/html');
  return html === undefined ? '' : htmlToText(decoded(html));
}

export const mailFilesOf = (m: GmailMessage): MailFile[] =>
  flatten(m.payload)
    .filter(isFile)
    .map((p) => {
      const name = p.filename ?? 'attachment';
      const mime = p.mimeType ?? 'application/octet-stream';
      return {
        attachmentId: p.body?.attachmentId ?? null,
        data: p.body?.data ?? null,
        name,
        mime,
        kind: kindOf(mime, name),
        ...(typeof p.body?.size === 'number' ? { size: p.body.size } : {}),
      };
    });

export const metaOf = (f: MailFile): AttachmentMeta => ({
  kind: f.kind,
  name: f.name,
  mime: f.mime,
  ...(f.size === undefined ? {} : { size: f.size }),
});

export function itemOf(m: GmailMessage): MailItem {
  const from = personOf(headerOf(m, 'From'));
  const at = Number(m.internalDate);
  return {
    id: m.id,
    threadId: m.threadId ?? m.id,
    subject: headerOf(m, 'Subject').trim(),
    from: from.address,
    fromName: from.name,
    to: addressesOf(headerOf(m, 'To')),
    cc: addressesOf(headerOf(m, 'Cc')),
    date: Number.isFinite(at) && at > 0 ? new Date(at).toISOString() : null,
    preview: decodeEntities(m.snippet ?? '').trim(),
    text: textOf(m),
    hasAttachments: mailFilesOf(m).length > 0 || m.payload?.mimeType === 'multipart/mixed',
    isRead: !(m.labelIds ?? []).includes('UNREAD'),
    internetMessageId: headerOf(m, 'Message-ID') || null,
  };
}
