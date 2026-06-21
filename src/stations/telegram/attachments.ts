import { tg, accounts } from './accounts.js';
import type { TgMsg } from './types.js';

const ATT_DIR =
  process.env.METRO_XMTP_ATTACH_DIR ??
  `${process.env.HOME}/.cache/metro/messenger-uploads`;

const MIME_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'audio/mp4': 'm4a',
  'audio/mpeg': 'mp3',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'application/pdf': 'pdf',
};

function extFromName(name: string | undefined): string | undefined {
  const ext = name?.split('?')[0]?.split('.').pop()?.toLowerCase();
  return ext && ext.length >= 1 && ext.length <= 5 ? ext : undefined;
}

function extFromMime(mime: string | undefined): string | undefined {
  if (!mime) return undefined;
  if (MIME_EXT[mime]) return MIME_EXT[mime];
  if (mime.startsWith('image/')) return mime.slice(6).replace('jpeg', 'jpg');
  return undefined;
}

function extFromPath(
  filePath: string | undefined,
  fileName: string | undefined,
  mime: string | undefined,
): string {
  return extFromName(fileName ?? filePath) ?? extFromMime(mime) ?? 'bin';
}

function isOggRef(mime: string | undefined, ref: string | undefined): boolean {
  const ext = ref?.split('?')[0]?.split('.').pop()?.toLowerCase();
  return mime === 'audio/ogg' || ext === 'ogg' || ext === 'oga';
}

export function mediaKindOf(
  kind: string | undefined,
  mime: string | undefined,
  ref: string | undefined,
): 'image' | 'voice' | 'document' {
  if (kind === 'image' || mime?.startsWith('image/')) return 'image';
  const isOgg = isOggRef(mime, ref);
  if (kind === 'voice' || (kind === 'audio' && isOgg)) return 'voice';
  if (!kind && isOgg) return 'voice';
  return 'document';
}

export interface SavedAttachment {
  path: string;
  mime?: string;
  name?: string;
  bytes: number;
}

export interface TgMediaRef {
  fileId: string;
  name?: string;
  mime?: string;
}

const MEDIA_EXTRACTORS: ((m: TgMsg) => TgMediaRef | null)[] = [
  (m) =>
    m.photo?.length
      ? { fileId: m.photo[m.photo.length - 1].file_id, mime: 'image/jpeg' }
      : null,
  (m) =>
    m.document?.file_id
      ? { fileId: m.document.file_id, name: m.document.file_name }
      : null,
  (m) =>
    m.video?.file_id
      ? { fileId: m.video.file_id, name: m.video.file_name, mime: 'video/mp4' }
      : null,
  (m) =>
    m.animation?.file_id
      ? { fileId: m.animation.file_id, name: m.animation.file_name }
      : null,
  (m) =>
    m.audio?.file_id
      ? { fileId: m.audio.file_id, name: m.audio.file_name }
      : null,
  (m) => (m.voice?.file_id ? { fileId: m.voice.file_id, mime: 'audio/ogg' } : null),
  (m) =>
    m.sticker?.file_id
      ? { fileId: m.sticker.file_id, mime: 'image/webp' }
      : null,
];

export function mediaRefOf(m: TgMsg): TgMediaRef | null {
  for (const extract of MEDIA_EXTRACTORS) {
    const ref = extract(m);
    if (ref) return ref;
  }
  return null;
}

export async function saveTelegramMedia(
  accountId: string,
  ref: TgMediaRef,
  messageId: string,
  index = 0,
): Promise<SavedAttachment> {
  const file = await tg<{ file_path?: string }>(accountId, 'getFile', {
    file_id: ref.fileId,
  });
  if (!file.file_path)
    throw new Error(`telegram getFile returned no file_path for ${ref.fileId}`);
  const acct = accounts.get(accountId);
  if (!acct) throw new Error(`unknown account '${accountId}'`);
  const res = await fetch(`${acct.fileApi}/${file.file_path}`, {
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok)
    throw new Error(
      `telegram file download ${res.status} for ${file.file_path}`,
    );
  const data = new Uint8Array(await res.arrayBuffer());
  const { mkdir, writeFile } = await import('node:fs/promises');
  const nodePath = await import('node:path');
  await mkdir(ATT_DIR, { recursive: true });
  const safeId =
    messageId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 16) || 'unknown';
  const ext = extFromPath(file.file_path, ref.name, ref.mime);
  const path = nodePath.join(ATT_DIR, `msg_${safeId}_${index}.${ext}`);
  await writeFile(path, data);
  return { path, mime: ref.mime, name: ref.name, bytes: data.length };
}
