import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { CHAT_FILE_MAX, CHAT_FILES_MAX, fileNameOf, fileTypeOf, INLINE_IMAGE_TYPES } from '@metro-labs/core/chat';
import { isRecord } from '@metro-labs/core/is-record';
import { errMsg, log } from '@metro-labs/core/log';

export const IMAGE_INLINE_MAX = 3.75 * 1024 * 1024;
const PATH_MAX = 4096;

export interface MissingFile {
  name: string;
  type: string;
  size: number;
}

export interface TurnFile extends MissingFile {
  path: string;
}

type ImageType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

interface ImageBlock {
  type: 'image';
  source: { type: 'base64'; media_type: ImageType; data: string };
}

export type UserContent = string | ({ type: 'text'; text: string } | ImageBlock)[];

const plainPath = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= PATH_MAX && isAbsolute(value) && resolve(value) === value && !/[\0\n]/.test(value);

function missingFileOf(raw: unknown): MissingFile | null {
  if (!isRecord(raw)) return null;
  const name = fileNameOf(raw.name);
  const { size } = raw;
  if (name === null || typeof size !== 'number' || !Number.isInteger(size) || size < 0 || size > CHAT_FILE_MAX) return null;
  return { name, type: fileTypeOf(raw.type), size };
}

function turnFileOf(raw: unknown): TurnFile | null {
  const file = missingFileOf(raw);
  return file === null || !isRecord(raw) || !plainPath(raw.path) ? null : { ...file, path: raw.path };
}

const listOf = <T>(raw: unknown, read: (item: unknown) => T | null): T[] =>
  Array.isArray(raw) ? raw.slice(0, CHAT_FILES_MAX).map(read).filter((item): item is T => item !== null) : [];

export const turnFilesOf = (raw: unknown): TurnFile[] => listOf(raw, turnFileOf);

export const missingFilesOf = (raw: unknown): MissingFile[] => listOf(raw, missingFileOf);

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ascii = (bytes: Buffer, from: number, to: number): string => bytes.subarray(from, to).toString('latin1');

export function imageTypeOf(bytes: Buffer): ImageType | null {
  if (bytes.subarray(0, 8).equals(PNG)) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (ascii(bytes, 0, 4) === 'GIF8') return 'image/gif';
  return ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP' ? 'image/webp' : null;
}

function readSmall(path: string, max: number): Buffer | null {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > max) return null;
    const buffer = Buffer.alloc(stat.size);
    return buffer.subarray(0, readSync(fd, buffer, 0, stat.size, 0));
  } finally {
    closeSync(fd);
  }
}

function imageBlock(file: TurnFile): ImageBlock | null {
  if (!INLINE_IMAGE_TYPES.has(file.type) || file.size > IMAGE_INLINE_MAX) return null;
  try {
    const bytes = readSmall(file.path, IMAGE_INLINE_MAX);
    const type = bytes === null ? null : imageTypeOf(bytes);
    return bytes === null || type === null ? null : { type: 'image', source: { type: 'base64', media_type: type, data: bytes.toString('base64') } };
  } catch (err) {
    log.warn({ err: errMsg(err) }, 'chat: an image could not be shown to the agent, so it is only listed');
    return null;
  }
}

export function userContent(text: string, files: readonly TurnFile[]): UserContent {
  const images = files.map(imageBlock).filter((block): block is ImageBlock => block !== null);
  return images.length === 0 ? text : [{ type: 'text', text }, ...images];
}
