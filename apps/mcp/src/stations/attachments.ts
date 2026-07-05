import type { CanonicalAttachment } from './types.js';

const ATT_DIR =
  process.env.METRO_XMTP_ATTACH_DIR ??
  `${process.env.HOME}/.cache/metro/messenger-uploads`;

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

const extFromName = (filename: string | undefined): string | undefined => {
  const ext = filename
    ?.split('?')[0]
    ?.split('#')[0]
    ?.split('.')
    .pop()
    ?.toLowerCase();
  return ext !== undefined && ext.length >= 1 && ext.length <= 5
    ? ext
    : undefined;
};

const extFromMime = (mime: string | undefined): string | undefined => {
  if (mime === undefined) return undefined;
  const mapped = MIME_EXT[mime];
  if (mapped) return mapped;
  if (mime.startsWith('image/')) return mime.slice(6).replace('jpeg', 'jpg');
  return undefined;
};

const extFor = (
  filename: string | undefined,
  mime: string | undefined,
): string => extFromName(filename) ?? extFromMime(mime) ?? 'bin';

const cacheFileName = (
  messageId: string,
  index: number,
  filename: string | undefined,
  mime: string | undefined,
): string => {
  const safeId =
    messageId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 16) || 'unknown';
  return `msg_${safeId}_${index}.${extFor(filename, mime)}`;
};

export interface SavedAttachment {
  path: string;
  mime?: string;
  name?: string;
  bytes: number;
}

export const MAX_ATTACHMENT_BYTES = Number(
  process.env.METRO_ATTACH_MAX_BYTES ?? 100 * 1024 * 1024,
);

export function assertAttachmentSize(bytes: number): void {
  if (bytes > MAX_ATTACHMENT_BYTES)
    throw new Error(
      `attachment size ${bytes} exceeds limit of ${MAX_ATTACHMENT_BYTES} bytes`,
    );
}

export function assertContentLength(header: string | null | undefined): void {
  if (header == null) return;
  const n = Number(header);
  if (Number.isFinite(n)) assertAttachmentSize(n);
}

export const saveBufferToCache = async (
  data: Uint8Array,
  messageId: string,
  index: number,
  meta: { mime?: string; name?: string },
): Promise<SavedAttachment> => {
  assertAttachmentSize(data.length);
  const { mkdir, writeFile } = await import('node:fs/promises');
  const nodePath = await import('node:path');
  await mkdir(ATT_DIR, { recursive: true });
  const path = nodePath.join(
    ATT_DIR,
    cacheFileName(messageId, index, meta.name, meta.mime),
  );
  await writeFile(path, data);
  return { path, mime: meta.mime, name: meta.name, bytes: data.length };
};

export const guessMime = (path: string): string => {
  const ext = (path.split('.').pop() ?? '').toLowerCase();
  const map: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    heic: 'image/heic',
    mp4: 'video/mp4',
    mov: 'video/quicktime',
    webm: 'video/webm',
    m4v: 'video/x-m4v',
    m4a: 'audio/mp4',
    mp3: 'audio/mpeg',
    ogg: 'audio/ogg',
    wav: 'audio/wav',
    pdf: 'application/pdf',
  };
  return map[ext] ?? 'application/octet-stream';
};

export const isImageMime = (mime: string): boolean =>
  mime.toLowerCase().startsWith('image/');
export const isImageExt = (path: string): boolean =>
  /\.(png|jpe?g|gif|webp|heic|bmp|svg)$/i.test(path);

export const appendFile = async (
  form: FormData,
  field: string,
  path: string,
  name: string,
): Promise<void> => {
  const data = await Bun.file(path).arrayBuffer();
  form.append(field, new Blob([data]), name);
};

export const toCanonical = (
  a: CanonicalAttachment,
): Record<string, unknown> => {
  const src = a.path ?? a.url ?? '';
  const mime = a.mime ?? (src ? guessMime(src) : '');
  return {
    kind: isImageMime(mime) || isImageExt(src) ? 'image' : 'file',
    url: src,
    name: a.name ?? src.split('/').pop() ?? undefined,
    ...(a.mime ? { mime: a.mime } : {}),
  };
};
