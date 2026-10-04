import { acceptsAvatar, AVATAR_ACCEPT, AVATAR_MAX_BYTES, AVATAR_PREFIX, AVATAR_SIZE, decodedSize, NOT_RASTER_TEXT } from '../components/avatar-file.js';

function drawSquare(bitmap: ImageBitmap): string {
  const canvas = document.createElement('canvas');
  canvas.width = AVATAR_SIZE;
  canvas.height = AVATAR_SIZE;
  const ctx = canvas.getContext('2d');
  if (ctx === null) throw new Error('This browser cannot draw the image.');
  const side = Math.min(bitmap.width, bitmap.height);
  const sx = Math.floor((bitmap.width - side) / 2);
  const sy = Math.floor((bitmap.height - side) / 2);
  ctx.drawImage(bitmap, sx, sy, side, side, 0, 0, AVATAR_SIZE, AVATAR_SIZE);
  return canvas.toDataURL('image/png');
}

async function readAvatar(file: File): Promise<string> {
  if (!acceptsAvatar(file.type)) throw new Error(NOT_RASTER_TEXT);
  const bitmap = await createImageBitmap(file).catch(() => {
    throw new Error('That file could not be read as an image.');
  });
  try {
    const url = drawSquare(bitmap);
    if (!url.startsWith(AVATAR_PREFIX) || decodedSize(url) > AVATAR_MAX_BYTES) throw new Error('That image is too detailed to store. Try a simpler one.');
    return url;
  } finally {
    bitmap.close();
  }
}

export function pickAvatar(): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = AVATAR_ACCEPT;
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (file === undefined) resolve(null);
      else readAvatar(file).then(resolve, reject);
    });
    input.addEventListener('cancel', () => {
      resolve(null);
    });
    input.click();
  });
}
