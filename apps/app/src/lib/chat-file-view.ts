import { useEffect, useState } from 'react';
import { Directory, File, Paths } from 'expo-file-system';
import { shareAsync } from 'expo-sharing';
import type { ChatFile } from '@metro-labs/core/chat';

interface Shown {
  blob: Blob;
  uri: string | null;
}

const UNREAD = 'The file could not be read.';

const dataUriOf = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') resolve(reader.result);
      else reject(new Error(UNREAD));
    };
    reader.onerror = () => {
      reject(new Error(UNREAD));
    };
    reader.readAsDataURL(blob);
  });

export function useBlobUri(blob: Blob | undefined): string | null | undefined {
  const [shown, setShown] = useState<Shown | null>(null);
  useEffect(() => {
    if (blob === undefined) return undefined;
    let live = true;
    dataUriOf(blob)
      .then((uri) => {
        if (live) setShown({ blob, uri });
      })
      .catch(() => {
        if (live) setShown({ blob, uri: null });
      });
    return () => {
      live = false;
    };
  }, [blob]);
  return shown !== null && shown.blob === blob ? shown.uri : undefined;
}

export async function saveChatFile(blob: Blob, file: ChatFile): Promise<void> {
  const data = await dataUriOf(blob);
  const folder = new Directory(Paths.cache, 'chat-files', file.id);
  folder.create({ intermediates: true, idempotent: true });
  const saved = new File(folder, file.name);
  if (saved.exists) saved.delete();
  saved.create();
  saved.write(data.slice(data.indexOf(',') + 1), { encoding: 'base64' });
  await shareAsync(saved.uri, { mimeType: file.type, dialogTitle: file.name });
}
