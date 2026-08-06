import type { proto } from '@whiskeysockets/baileys';
import { extFromMime } from '@metro-labs/mcp/stations/attachments';

export type WAMediaKind =
  | 'image'
  | 'video'
  | 'voice'
  | 'audio'
  | 'document'
  | 'sticker';

export interface WAMediaRef {
  kind: WAMediaKind;
  mime?: string;
  name?: string;
  bytes?: number;
}

interface Long {
  toNumber(): number;
}

interface MediaNode {
  mimetype?: string | null;
  fileName?: string | null;
  fileLength?: number | Long | null;
  ptt?: boolean | null;
}

const MEDIA_NODES: [keyof proto.IMessage, WAMediaKind][] = [
  ['imageMessage', 'image'],
  ['videoMessage', 'video'],
  ['audioMessage', 'audio'],
  ['documentMessage', 'document'],
  ['stickerMessage', 'sticker'],
];

const EXT_BY_KIND: Record<WAMediaKind, string> = {
  image: 'jpg',
  video: 'mp4',
  voice: 'ogg',
  audio: 'mp3',
  document: 'bin',
  sticker: 'webp',
};

function toBytes(v: number | Long | null | undefined): number | undefined {
  if (typeof v === 'number') return v;
  if (v && typeof v.toNumber === 'function') return v.toNumber();
  return undefined;
}

function baseMime(v: string | null | undefined): string | undefined {
  const first = typeof v === 'string' ? (v.split(';')[0] ?? '').trim() : '';
  return first || undefined;
}

function fallbackName(kind: WAMediaKind, mime: string | undefined): string {
  const ext = extFromMime(mime) ?? EXT_BY_KIND[kind];
  return kind === 'voice' ? `voice-message.${ext}` : `${kind}.${ext}`;
}

export function mediaRefIn(inner: proto.IMessage): WAMediaRef | undefined {
  for (const [key, base] of MEDIA_NODES) {
    const node = inner[key] as MediaNode | null | undefined;
    if (!node) continue;
    const kind = base === 'audio' && node.ptt === true ? 'voice' : base;
    const mime = baseMime(node.mimetype);
    const bytes = toBytes(node.fileLength);
    return {
      kind,
      ...(mime ? { mime } : {}),
      name: node.fileName ?? fallbackName(kind, mime),
      ...(bytes === undefined ? {} : { bytes }),
    };
  }
  return undefined;
}

export function mediaTag(ref: WAMediaRef | undefined): string | undefined {
  if (!ref) return undefined;
  if (ref.kind === 'document') return `[document: ${ref.name ?? 'document'}]`;
  return `[${ref.kind}]`;
}
