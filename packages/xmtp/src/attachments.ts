import {
  AttachmentCodec,
  RemoteAttachmentCodec,
  ContentTypeAttachment,
} from '@xmtp/content-type-remote-attachment';
import {
  saveBufferToCache,
  assertAttachmentSize,
} from '@metro-labs/mcp/stations/attachments';
import type { SavedAttachment } from '@metro-labs/mcp/stations/attachments';

export type { SavedAttachment };

const attachmentCodec = new AttachmentCodec();
const loadRegistry = {
  codecFor: (ct: { typeId?: string }) =>
    ct.typeId === ContentTypeAttachment.typeId ? attachmentCodec : undefined,
};

export interface RemoteEntry {
  url: string;
  filename?: string;
  contentDigest?: string;
  nonce?: Uint8Array;
  salt?: Uint8Array;
  secret?: Uint8Array;
  scheme?: string;
  contentLength?: number;
}

export async function saveInlineAttachment(
  a: { filename?: string; mimeType?: string; content: Uint8Array },
  messageId: string,
  index = 0,
): Promise<SavedAttachment> {
  return saveBufferToCache(a.content, messageId, index, {
    mime: a.mimeType,
    name: a.filename,
  });
}

function toRemoteDescriptor(r: RemoteEntry): {
  url: string;
  contentDigest: string;
  salt: Uint8Array;
  nonce: Uint8Array;
  secret: Uint8Array;
  scheme: string;
  contentLength: number;
  filename: string;
} {
  return {
    url: r.url,
    contentDigest: r.contentDigest ?? '',
    salt: r.salt ?? new Uint8Array(),
    nonce: r.nonce ?? new Uint8Array(),
    secret: r.secret ?? new Uint8Array(),
    scheme: r.scheme ?? 'https://',
    contentLength: r.contentLength ?? 0,
    filename: r.filename ?? '',
  };
}

export async function saveRemoteAttachment(
  r: RemoteEntry,
  messageId: string,
  index = 0,
): Promise<SavedAttachment> {
  if (r.contentLength) assertAttachmentSize(r.contentLength);
  const decoded = await RemoteAttachmentCodec.load<{
    filename?: string;
    mimeType?: string;
    data: Uint8Array;
  }>(toRemoteDescriptor(r), loadRegistry);
  return saveBufferToCache(decoded.data, messageId, index, {
    mime: decoded.mimeType,
    name: decoded.filename ?? r.filename,
  });
}
