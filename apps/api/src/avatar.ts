import { ApiError } from '@metro-labs/http/api-error';

export const AVATAR_MAX_BYTES = 96 * 1024;
export const AVATAR_BODY_MAX = 192 * 1024;
const AVATAR_SIDE_MAX = 256;
const DATA_RE = /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_END = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
const IHDR_AT = 12;
const WIDTH_AT = 16;
const HEIGHT_AT = 20;
const MIN_PNG = 33;

export class AvatarError extends ApiError {
  constructor(message: string) {
    super(message, 400);
  }
}

const notPng = (): AvatarError => new AvatarError('the avatar must be a PNG image');

function decodeStrict(text: string): Buffer {
  if (text.length % 4 !== 0) throw notPng();
  const padding = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0;
  const bytes = Buffer.from(text, 'base64');
  if (bytes.length !== (text.length / 4) * 3 - padding) throw notPng();
  return bytes;
}

function assertPng(bytes: Buffer): void {
  if (bytes.length < MIN_PNG || !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) throw notPng();
  if (bytes.toString('latin1', IHDR_AT, IHDR_AT + 4) !== 'IHDR') throw notPng();
  if (!bytes.subarray(-PNG_END.length).equals(PNG_END)) throw notPng();
  const width = bytes.readUInt32BE(WIDTH_AT);
  const height = bytes.readUInt32BE(HEIGHT_AT);
  if (width === 0 || height === 0 || width > AVATAR_SIDE_MAX || height > AVATAR_SIDE_MAX)
    throw new AvatarError(`the avatar must be at most ${String(AVATAR_SIDE_MAX)} by ${String(AVATAR_SIDE_MAX)} pixels`);
}

export function parseAvatar(raw: unknown): string | null {
  if (raw === null) return null;
  if (typeof raw !== 'string') throw new AvatarError('avatar must be a PNG data url, or null to remove it');
  const match = DATA_RE.exec(raw);
  const text = match?.[1];
  if (text === undefined) throw new AvatarError('the avatar must be a data:image/png;base64 url');
  const bytes = decodeStrict(text);
  if (bytes.length > AVATAR_MAX_BYTES) throw new AvatarError(`the avatar must be under ${String(AVATAR_MAX_BYTES / 1024)} KiB`);
  assertPng(bytes);
  return `data:image/png;base64,${text}`;
}
