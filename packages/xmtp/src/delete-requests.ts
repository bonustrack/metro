import type { DecodedMessage } from '@xmtp/node-sdk';
import { ContentTypeDeleteRequest } from './codecs.js';

type Listed = Pick<DecodedMessage, 'id' | 'senderInboxId' | 'contentType' | 'content'>;

export const isDeleteRequest = (m: Pick<Listed, 'contentType'>): boolean =>
  m.contentType?.authorityId === ContentTypeDeleteRequest.authorityId &&
  m.contentType.typeId === ContentTypeDeleteRequest.typeId;

function targetOf(m: Listed): string | undefined {
  if (!isDeleteRequest(m)) return undefined;
  const id = (m.content as { messageId?: unknown } | undefined)?.messageId;
  return typeof id === 'string' && id ? id : undefined;
}

export function superAdminCheck(conv: unknown): (inboxId: string) => boolean {
  const group = conv as { isSuperAdmin?: (inboxId: string) => boolean };
  return (inboxId) => typeof group.isSuperAdmin === 'function' && group.isSuperAdmin(inboxId);
}

export function deletedByRequests(
  messages: Listed[],
  isSuperAdmin: (inboxId: string) => boolean,
): Set<string> {
  const senders = new Map(messages.map((m) => [m.id, m.senderInboxId]));
  const deleted = new Set<string>();
  for (const m of messages) {
    const target = targetOf(m);
    const sender = target === undefined ? undefined : senders.get(target);
    if (target !== undefined && sender !== undefined && (sender === m.senderInboxId || isSuperAdmin(m.senderInboxId)))
      deleted.add(target);
  }
  return deleted;
}
