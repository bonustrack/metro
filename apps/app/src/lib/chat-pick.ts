import { getDocumentAsync } from 'expo-document-picker';
import { File } from 'expo-file-system';
import { launchImageLibraryAsync, UIImagePickerPreferredAssetRepresentationMode } from 'expo-image-picker';
import { CHAT_FILES_MAX } from '@metro-labs/core/chat';
import { isInlineImage, pickedFile, type PickedFile } from './chat-files.js';

export type PickSource = 'photos' | 'files';

export const PICK_SOURCES: readonly PickSource[] = ['photos', 'files'];

const fromUri = (uri: string, name: string | null | undefined, type: string | null | undefined, size: number | null | undefined): PickedFile =>
  pickedFile({ name, type, size: size ?? new File(uri).size, preview: (shown) => (isInlineImage(shown) ? uri : null), body: () => new File(uri).arrayBuffer() });

export async function pickChatFiles(source: PickSource): Promise<PickedFile[]> {
  if (source === 'photos') {
    const photos = await launchImageLibraryAsync({ mediaTypes: ['images'], allowsMultipleSelection: true, selectionLimit: CHAT_FILES_MAX, quality: 1, preferredAssetRepresentationMode: UIImagePickerPreferredAssetRepresentationMode.Compatible });
    return photos.canceled ? [] : photos.assets.map((asset) => fromUri(asset.uri, asset.fileName, asset.mimeType, asset.fileSize));
  }
  const files = await getDocumentAsync({ type: '*/*', multiple: true, copyToCacheDirectory: true });
  return files.canceled ? [] : files.assets.map((asset) => fromUri(asset.uri, asset.name, asset.mimeType, asset.size));
}

export const releasePicked: (file: PickedFile) => void = () => undefined;

export const usePastedFiles: (enabled: boolean, onFiles: (files: PickedFile[]) => void) => void = () => undefined;
