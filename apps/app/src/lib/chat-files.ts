import { CHAT_FILE_MAX, CHAT_FILES_MAX, fileNameOf, fileTypeOf, INLINE_IMAGE_TYPES, type ChatFile } from '@metro-labs/core/chat';
import type { ChatFileBody } from '@metro-labs/client/api/chat-files';
import type { ChatFileInput } from '@metro-labs/client/api/chats';
import type { ServerStatus } from '@metro-labs/client/api/servers';
import { olderThan } from '@metro-labs/client/api/version';

const CHAT_FILES_SINCE = '0.1.0-beta.343';
const KB = 1024;
const MB = KB * KB;

export interface PickedFile {
  key: string;
  name: string;
  type: string;
  size: number;
  preview: string | null;
  body: () => Promise<ChatFileBody>;
}

interface RawPick {
  name: string | null | undefined;
  type: string | null | undefined;
  size: number;
  preview: (type: string) => string | null;
  body: () => Promise<ChatFileBody>;
}

let picks = 0;

export const isInlineImage = (type: string): boolean => INLINE_IMAGE_TYPES.has(type.toLowerCase());

export function pickedFile(raw: RawPick): PickedFile {
  picks += 1;
  const type = fileTypeOf(raw.type);
  return { key: `pick-${String(picks)}`, name: fileNameOf(raw.name) ?? 'file', type, size: raw.size, preview: raw.preview(type), body: raw.body };
}

export function sizeWords(bytes: number): string {
  if (bytes < KB) return `${String(bytes)} B`;
  if (bytes < MB) return `${String(Math.round(bytes / KB))} KB`;
  const mb = bytes / MB;
  return `${mb < 10 ? mb.toFixed(1) : String(Math.round(mb))} MB`;
}

export interface Added {
  files: PickedFile[];
  refused: string | null;
}

export function addPicked(now: readonly PickedFile[], picked: readonly PickedFile[]): Added {
  const fitting = picked.filter((file) => file.size <= CHAT_FILE_MAX);
  const room = Math.max(0, CHAT_FILES_MAX - now.length);
  const kept = fitting.slice(0, room);
  const big = picked.find((file) => file.size > CHAT_FILE_MAX);
  const refused =
    big !== undefined
      ? `${big.name} is larger than ${sizeWords(CHAT_FILE_MAX)}, the most one file can be.`
      : kept.length < fitting.length
        ? `A message can carry ${String(CHAT_FILES_MAX)} files at most.`
        : null;
  return { files: [...now, ...kept], refused };
}

export const fileInputOf = (file: PickedFile): ChatFileInput => ({ name: file.name, type: file.type, size: file.size });

export interface HeldFile {
  file: ChatFile;
  picked: PickedFile;
}

export function pairFiles(sent: readonly ChatFile[], picked: readonly PickedFile[]): HeldFile[] {
  return sent.flatMap((file, index) => {
    const local = picked[index];
    return local !== undefined && local.size === file.size ? [{ file, picked: local }] : [];
  });
}

export const filesAllowed = (status: ServerStatus | undefined): boolean => status !== undefined && status.state === 'live' && !olderThan(status.version, CHAT_FILES_SINCE);
