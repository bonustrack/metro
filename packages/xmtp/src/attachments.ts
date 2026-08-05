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
import { errMsg } from '@metro-labs/mcp/log';

export type { SavedAttachment };

export const REMOTE_FETCH_ATTEMPTS = 3;
const REMOTE_FETCH_BACKOFF_MS = 400;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

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

interface DecodedAttachment {
  filename?: string;
  mimeType?: string;
  data: Uint8Array;
}

async function loadRemote(r: RemoteEntry): Promise<DecodedAttachment> {
  let last = '';
  for (let attempt = 1; attempt <= REMOTE_FETCH_ATTEMPTS; attempt += 1) {
    try {
      return await RemoteAttachmentCodec.load<DecodedAttachment>(
        toRemoteDescriptor(r),
        loadRegistry,
      );
    } catch (err) {
      last = errMsg(err);
      if (attempt < REMOTE_FETCH_ATTEMPTS)
        await sleep(REMOTE_FETCH_BACKOFF_MS * attempt);
    }
  }
  throw new Error(
    `xmtp remote attachment fetch failed after ${REMOTE_FETCH_ATTEMPTS} attempts: ${last}`,
  );
}

export async function saveRemoteAttachment(
  r: RemoteEntry,
  messageId: string,
  index = 0,
): Promise<SavedAttachment> {
  if (r.contentLength) assertAttachmentSize(r.contentLength);
  const decoded = await loadRemote(r);
  return saveBufferToCache(decoded.data, messageId, index, {
    mime: decoded.mimeType,
    name: decoded.filename ?? r.filename,
  });
}
