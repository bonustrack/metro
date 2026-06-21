import {
  AttachmentCodec,
  RemoteAttachmentCodec,
  ContentTypeAttachment,
} from '@xmtp/content-type-remote-attachment';

const ATT_DIR =
  process.env.METRO_XMTP_ATTACH_DIR ??
  `${process.env.HOME}/.cache/metro/messenger-uploads`;

const attachmentCodec = new AttachmentCodec();
const loadRegistry = {
  codecFor: (ct: { typeId?: string }) =>
    ct.typeId === ContentTypeAttachment.typeId ? attachmentCodec : undefined,
};

const MIME_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'audio/mp4': 'm4a',
  'audio/mpeg': 'mp3',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'application/pdf': 'pdf',
};

function extFromName(filename: string | undefined): string | undefined {
  const fromName = filename
    ?.split('?')[0]
    ?.split('#')[0]
    ?.split('.')
    .pop()
    ?.toLowerCase();
  const ok =
    fromName !== undefined && fromName.length >= 1 && fromName.length <= 5;
  return ok ? fromName : undefined;
}

function extFromMime(mime: string | undefined): string | undefined {
  if (mime === undefined) return undefined;
  const mapped = MIME_EXT[mime];
  if (mapped) return mapped;
  if (mime.startsWith('image/')) return mime.slice(6).replace('jpeg', 'jpg');
  return undefined;
}

function extFor(
  filename: string | undefined,
  mime: string | undefined,
): string {
  return extFromName(filename) ?? extFromMime(mime) ?? 'bin';
}

function fileName(
  messageId: string,
  index: number,
  filename: string | undefined,
  mime: string | undefined,
): string {
  const safeId =
    messageId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 16) || 'unknown';
  return `msg_${safeId}_${index}.${extFor(filename, mime)}`;
}

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

export interface SavedAttachment {
  path: string;
  mime?: string;
  name?: string;
  bytes: number;
}

async function writeBytes(
  data: Uint8Array,
  messageId: string,
  index: number,
  filename: string | undefined,
  mime: string | undefined,
): Promise<SavedAttachment> {
  const { mkdir, writeFile } = await import('node:fs/promises');
  const nodePath = await import('node:path');
  await mkdir(ATT_DIR, { recursive: true });
  const path = nodePath.join(
    ATT_DIR,
    fileName(messageId, index, filename, mime),
  );
  await writeFile(path, data);
  return { path, mime, name: filename, bytes: data.length };
}

export async function saveInlineAttachment(
  a: { filename?: string; mimeType?: string; content: Uint8Array },
  messageId: string,
  index = 0,
): Promise<SavedAttachment> {
  return writeBytes(a.content, messageId, index, a.filename, a.mimeType);
}

export async function saveRemoteAttachment(
  r: RemoteEntry,
  messageId: string,
  index = 0,
): Promise<SavedAttachment> {
  const remote = {
    url: r.url,
    contentDigest: r.contentDigest ?? '',
    salt: r.salt ?? new Uint8Array(),
    nonce: r.nonce ?? new Uint8Array(),
    secret: r.secret ?? new Uint8Array(),
    scheme: r.scheme ?? 'https://',
    contentLength: r.contentLength ?? 0,
    filename: r.filename ?? '',
  };
  const decoded = await RemoteAttachmentCodec.load<{
    filename?: string;
    mimeType?: string;
    data: Uint8Array;
  }>(remote, loadRegistry);
  return writeBytes(
    decoded.data,
    messageId,
    index,
    decoded.filename ?? r.filename,
    decoded.mimeType,
  );
}
