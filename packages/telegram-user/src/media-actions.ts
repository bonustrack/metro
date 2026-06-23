import type { InputMediaLike, Message } from '@mtcute/bun';
import { InputMedia } from '@mtcute/bun';
import { isImageMime, isImageExt } from '@metro-labs/mcp/stations/attachments';
import type { UserClient } from './client.js';

export interface CanonicalAttachment {
  kind?: string;
  url?: string;
  mime?: string;
  name?: string;
}

function isImage(att: CanonicalAttachment): boolean {
  if (att.kind === 'image') return true;
  if (att.mime !== undefined) return isImageMime(att.mime);
  return att.url !== undefined && isImageExt(att.url);
}

export function buildInputMedia(
  att: CanonicalAttachment,
  caption: string | undefined,
): InputMediaLike {
  const file = att.url ?? '';
  const params = {
    ...(caption ? { caption } : {}),
    ...(att.name ? { fileName: att.name } : {}),
  };
  return isImage(att)
    ? InputMedia.photo(file, params)
    : InputMedia.document(file, params);
}

interface SendMediaTarget {
  client: UserClient;
  chatId: number;
  replyTo?: number;
}

export async function sendAttachments(
  target: SendMediaTarget,
  attachments: CanonicalAttachment[],
  text: string,
): Promise<Message> {
  const { client, chatId, replyTo } = target;
  const peer = await client.tg.resolvePeer(chatId);
  let last: Message | undefined;
  for (let i = 0; i < attachments.length; i++) {
    const att = attachments[i];
    if (!att) continue;
    const caption = i === 0 ? text : undefined;
    last = await client.tg.sendMedia(peer, buildInputMedia(att, caption), {
      ...(replyTo !== undefined ? { replyTo } : {}),
    });
  }
  if (!last) throw new Error('no attachments were sent');
  return last;
}
