import { stat } from 'node:fs/promises';

const MAX_INLINE_BYTES = 4 * 1024 * 1024;

export interface SavedMedia {
  contentType?: string;
  attachmentFor?: string;
  attachmentPath?: string;
  localPath?: string;
  url?: string;
  mime?: string;
  name?: string;
  index?: number;
}

export interface MediaNote {
  content: string;
  kind: string;
  name: string;
  path: string;
}

export function mediaKind(mime?: string, name?: string): string {
  const m = (mime ?? '').toLowerCase();
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  const n = name ?? '';
  if (/\.(png|jpe?g|gif|webp|heic)$/i.test(n)) return 'image';
  if (/\.(mp4|mov|webm|m4v)$/i.test(n)) return 'video';
  if (/\.(m4a|mp3|ogg|wav)$/i.test(n)) return 'audio';
  return 'file';
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

function howToRead(url: string | undefined, tooBig: boolean): string {
  if (!url)
    return 'That path is on the daemon host, not on yours - this file is readable only by an agent running there.';
  if (tooBig)
    return 'Large file - fetch the Public URL only if you need the bytes, and do not inline it. The path is on the daemon host, not on yours.';
  return 'Fetch the Public URL to view it. The path is on the daemon host, so the Read tool works only for an agent running there.';
}

export async function buildMediaNote(
  p: SavedMedia,
  caption: string,
): Promise<MediaNote | null> {
  const path = p.attachmentPath ?? p.localPath;
  if (!path) return null;
  const kind = mediaKind(p.mime, p.name);
  const name = p.name ?? path.split('/').pop() ?? 'attachment';
  const size = await fileSize(path);
  const sizeNote = size ? ` (${(size / 1024 / 1024).toFixed(2)} MB)` : '';
  const content =
    (caption ? `${caption}\n` : '') +
    `[${kind} attachment received: ${name}${p.mime ? `, ${p.mime}` : ''}${sizeNote}]\n` +
    (p.url ? `Public URL: ${p.url}\n` : '') +
    `Daemon-host path: ${path}\n` +
    howToRead(p.url, size > MAX_INLINE_BYTES);
  return { content, kind, name, path };
}
