import type { Message } from '@mtcute/bun';
import { FileLocation } from '@mtcute/bun';
import {
  saveBufferToCache,
  type SavedAttachment,
} from '@metro-labs/mcp/stations/attachments';
import type { UserClient } from './client.js';

type Media = NonNullable<Message['media']>;
export type DownloadableMedia = Media & FileLocation;

export function isDownloadable(media: Media): media is DownloadableMedia {
  return media instanceof FileLocation;
}

interface MediaMeta {
  mime?: string;
  name?: string;
}

function metaOf(media: DownloadableMedia): MediaMeta {
  const withMime = media as { mimeType?: unknown };
  const withName = media as { fileName?: unknown };
  const mime =
    typeof withMime.mimeType === 'string' ? withMime.mimeType : undefined;
  const name =
    typeof withName.fileName === 'string' ? withName.fileName : undefined;
  return {
    ...(mime ? { mime } : {}),
    ...(name ? { name } : {}),
  };
}

export async function downloadMedia(
  client: UserClient,
  media: DownloadableMedia,
  messageId: string,
  index = 0,
): Promise<SavedAttachment> {
  const buf = await client.tg.downloadAsBuffer(media);
  return saveBufferToCache(buf, messageId, index, metaOf(media));
}
