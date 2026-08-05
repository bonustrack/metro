import type { InputMediaLike, Message } from '@mtcute/bun';
import { InputMedia } from '@mtcute/bun';
import { isImageMime, isImageExt } from '@metro-labs/mcp/stations/attachments';
import type { UserClient } from './client.js';

export interface CanonicalAttachment {
  kind?: string;
  path?: string;
  url?: string;
  mime?: string;
  name?: string;
}

const srcOf = (att: CanonicalAttachment): string => att.path ?? att.url ?? '';

function isImage(att: CanonicalAttachment): boolean {
  if (att.kind === 'image') return true;
  if (att.mime !== undefined) return isImageMime(att.mime);
  const src = srcOf(att);
  return src !== '' && isImageExt(src);
}

function fileRef(att: CanonicalAttachment): string {
  const src = srcOf(att);
  if (src === '' || /^https?:\/\//i.test(src)) return src;
  return src.startsWith('file:') ? src : `file:${src}`;
}

export interface OutgoingMedia {
  media: InputMediaLike;
  kind: string;
}

export function buildInputMedia(
  att: CanonicalAttachment,
  caption: string | undefined,
): OutgoingMedia {
  const file = fileRef(att);
  const params = {
    ...(caption ? { caption } : {}),
    ...(att.name ? { fileName: att.name } : {}),
  };
  return isImage(att)
    ? { media: InputMedia.photo(file, params), kind: 'image' }
    : { media: InputMedia.document(file, params), kind: 'file' };
}

interface SendMediaTarget {
  client: UserClient;
  chatId: number;
  replyTo?: number;
}

export interface SentMedia {
  message: Message;
  delivered: string[];
}

export async function sendAttachments(
  target: SendMediaTarget,
  attachments: CanonicalAttachment[],
  text: string,
): Promise<SentMedia> {
  const { client, chatId, replyTo } = target;
  const peer = await client.tg.resolvePeer(chatId);
  let last: Message | undefined;
  const delivered: string[] = [];
  for (let i = 0; i < attachments.length; i++) {
    const att = attachments[i];
    if (!att || srcOf(att) === '') continue;
    const caption = i === 0 ? text : undefined;
    const out = buildInputMedia(att, caption);
    last = await client.tg.sendMedia(peer, out.media, {
      ...(replyTo !== undefined ? { replyTo } : {}),
    });
    delivered.push(out.kind);
  }
  if (!last) throw new Error('no attachments were sent');
  return { message: last, delivered };
}
