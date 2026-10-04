import { File, Paths } from 'expo-file-system';
import { shareAsync } from 'expo-sharing';
import { getDocumentAsync } from 'expo-document-picker';

export async function saveText(text: string, name: string): Promise<void> {
  const file = new File(Paths.cache, name);
  if (file.exists) file.delete();
  file.create();
  file.write(text);
  await shareAsync(file.uri, { mimeType: 'application/octet-stream', dialogTitle: name });
}

export async function pickText(accept: string): Promise<string | null> {
  const picked = await getDocumentAsync({ type: accept.includes('/') ? '*/*' : '*/*', copyToCacheDirectory: true });
  const asset = picked.canceled ? undefined : picked.assets[0];
  if (asset === undefined) return null;
  return new File(asset.uri).text();
}
