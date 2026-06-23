import { saveBufferToCache } from '@metro-labs/station-kit/attachments';
import type { SavedAttachment } from '@metro-labs/station-kit/attachments';

export type { SavedAttachment };

export interface DiscordAttachmentRef {
  url: string;
  name?: string | null;
  contentType?: string | null;
}

export async function saveDiscordAttachment(
  a: DiscordAttachmentRef,
  messageId: string,
  index = 0,
): Promise<SavedAttachment> {
  const res = await fetch(a.url, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok)
    throw new Error(`discord attachment fetch ${res.status} for ${a.url}`);
  const data = new Uint8Array(await res.arrayBuffer());
  return saveBufferToCache(data, messageId, index, {
    mime: a.contentType ?? undefined,
    name: a.name ?? undefined,
  });
}
