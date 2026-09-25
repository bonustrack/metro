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

function drawSquare(bitmap: ImageBitmap): string {
  const canvas = document.createElement('canvas');
  canvas.width = AVATAR_SIDE;
  canvas.height = AVATAR_SIDE;
  const ctx = canvas.getContext('2d');
  if (ctx === null) throw new Error('This browser cannot draw the image.');
  const side = Math.min(bitmap.width, bitmap.height);
  const sx = Math.floor((bitmap.width - side) / 2);
  const sy = Math.floor((bitmap.height - side) / 2);
  ctx.drawImage(bitmap, sx, sy, side, side, 0, 0, AVATAR_SIDE, AVATAR_SIDE);
  return canvas.toDataURL('image/png');
}

export async function readAvatar(file: File): Promise<string> {
  if (!acceptsAvatar(file.type)) throw new Error(NOT_RASTER);
  const bitmap = await createImageBitmap(file).catch(() => {
    throw new Error('That file could not be read as an image.');
  });
  try {
    const url = drawSquare(bitmap);
    if (!url.startsWith(PREFIX) || decodedSize(url) > AVATAR_MAX_BYTES) throw new Error('That image is too detailed to store. Try a simpler one.');
    return url;
  } finally {
    bitmap.close();
  }
}
