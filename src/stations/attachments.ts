import type { CanonicalAttachment } from './types.js';

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
