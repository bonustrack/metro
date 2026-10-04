import { launchImageLibraryAsync } from 'expo-image-picker';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { AVATAR_MAX_BYTES, AVATAR_PREFIX, AVATAR_SIZE, decodedSize } from '../components/avatar-file.js';

export async function pickAvatar(): Promise<string | null> {
  const picked = await launchImageLibraryAsync({ mediaTypes: ['images'], allowsEditing: true, aspect: [1, 1], quality: 1 });
  const asset = picked.canceled ? undefined : picked.assets[0];
  if (asset === undefined) return null;
  const context = ImageManipulator.manipulate(asset.uri);
  context.resize({ width: AVATAR_SIZE, height: AVATAR_SIZE });
  const image = await context.renderAsync();
  const saved = await image.saveAsync({ format: SaveFormat.PNG, base64: true });
  const url = `${AVATAR_PREFIX}${saved.base64 ?? ''}`;
  if (saved.base64 === undefined || decodedSize(url) > AVATAR_MAX_BYTES) throw new Error('That image is too detailed to store. Try a simpler one.');
  return url;
}
