import {
  saveBufferToCache,
  assertContentLength,
} from '@metro-labs/mcp/stations/attachments';
import type { SavedAttachment } from '@metro-labs/mcp/stations/attachments';
import { tg, accounts } from './accounts.js';
import type { TgMsg } from './types.js';

export type { SavedAttachment };

function isOggRef(mime: string | undefined, ref: string | undefined): boolean {
  const ext = ref?.split('?')[0]?.split('.').pop()?.toLowerCase();
  return mime === 'audio/ogg' || ext === 'ogg' || ext === 'oga';
}

function isVoiceRef(
  kind: string | undefined,
  mime: string | undefined,
  ref: string | undefined,
): boolean {
  const isOgg = isOggRef(mime, ref);
  if (kind === 'voice') return true;
  if (kind === 'audio') return isOgg;
  return !kind && isOgg;
}

export function mediaKindOf(
  kind: string | undefined,
  mime: string | undefined,
  ref: string | undefined,
): 'image' | 'voice' | 'audio' | 'video' | 'document' {
  const m = mime ?? '';
  if (kind === 'image' || m.startsWith('image/')) return 'image';
  if (isVoiceRef(kind, mime, ref)) return 'voice';
  if (kind === 'video' || m.startsWith('video/')) return 'video';
  if (kind === 'audio' || m.startsWith('audio/')) return 'audio';
  return 'document';
}

export interface TgMediaRef {
  fileId: string;
  name?: string;
  mime?: string;
}

const MEDIA_EXTRACTORS: ((m: TgMsg) => TgMediaRef | null)[] = [
  (m) => {
    const largest = m.photo?.[m.photo.length - 1];
    return largest ? { fileId: largest.file_id, mime: 'image/jpeg' } : null;
  },
  (m) =>
    m.document?.file_id
      ? {
          fileId: m.document.file_id,
          name: m.document.file_name,
          mime: m.document.mime_type,
        }
      : null,
  (m) =>
    m.video?.file_id
      ? {
          fileId: m.video.file_id,
          name: m.video.file_name,
          mime: m.video.mime_type ?? 'video/mp4',
        }
      : null,
  (m) =>
    m.animation?.file_id
      ? {
          fileId: m.animation.file_id,
          name: m.animation.file_name,
          mime: m.animation.mime_type,
        }
      : null,
  (m) =>
    m.audio?.file_id
      ? {
          fileId: m.audio.file_id,
          name: m.audio.file_name,
          mime: m.audio.mime_type,
        }
      : null,
  (m) =>
    m.voice?.file_id
      ? { fileId: m.voice.file_id, mime: m.voice.mime_type ?? 'audio/ogg' }
      : null,
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
  assertContentLength(res.headers.get('content-length'));
  const data = new Uint8Array(await res.arrayBuffer());
  const saved = await saveBufferToCache(data, messageId, index, {
    mime: ref.mime,
    name: ref.name ?? file.file_path,
  });
  return { ...saved, name: ref.name };
}
