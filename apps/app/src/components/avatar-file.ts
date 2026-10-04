const RASTER_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;
export const AVATAR_ACCEPT = RASTER_TYPES.join(',');
const AVATAR_SIDE = 128;
export const AVATAR_MAX_BYTES = 96 * 1024;
const NOT_RASTER = 'Pick a PNG, JPEG, WebP or GIF image. SVG is not accepted.';
const PREFIX = 'data:image/png;base64,';

export const acceptsAvatar = (type: string): boolean => (RASTER_TYPES as readonly string[]).includes(type.toLowerCase());

export function decodedSize(dataUrl: string): number {
  const text = dataUrl.slice(PREFIX.length);
  const padding = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0;
  return (text.length / 4) * 3 - padding;
}

export const AVATAR_PREFIX = PREFIX;

export const AVATAR_SIZE = AVATAR_SIDE;

export const NOT_RASTER_TEXT = NOT_RASTER;
