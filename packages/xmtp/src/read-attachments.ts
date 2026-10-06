import type { DecodedMessage } from '@xmtp/node-sdk';
import { kindOf } from '@metro-labs/core/stations/attachments';
import { saveInlineAttachment, saveRemoteAttachment, type RemoteEntry, type SavedAttachment } from './attachments.js';

interface ReadAttachment {
  name?: string;
  mime?: string;
  kind: string;
  size: number;
  local_path: string;
}

function fileOf(saved: SavedAttachment): ReadAttachment {
  return {
    name: saved.name,
    mime: saved.mime,
    kind: kindOf(saved.mime ?? '', saved.path),
    size: saved.bytes,
    local_path: saved.path,
  };
}

export async function readAttachments(message: DecodedMessage): Promise<ReadAttachment[]> {
  const type = message.contentType?.typeId;
  if (type === 'attachment') {
    const content = message.content as { filename?: string; mimeType?: string; content: Uint8Array };
    return [fileOf(await saveInlineAttachment(content, message.id))];
  }
  if (type === 'remoteStaticAttachment')
    return [fileOf(await saveRemoteAttachment(message.content as RemoteEntry, message.id))];
  if (type === 'multiRemoteStaticAttachment' || type === 'multiRemoteAttachment') {
    const content = message.content as { attachments: RemoteEntry[] };
    return Promise.all(content.attachments.map(async (entry, index) =>
      fileOf(await saveRemoteAttachment(entry, message.id, index))));
  }
  return [];
}
